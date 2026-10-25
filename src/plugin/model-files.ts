import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { EncoderSpec, ModelFile } from "../core/encoder-spec.ts";

export type ModelCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

export type ModelSource = { readonly kind: "download"; readonly baseUrl: string } | { readonly kind: "folder"; readonly dir: string };

export type AcquireResult = { readonly kind: "installed" } | { readonly kind: "cancelled" } | { readonly kind: "failed"; readonly message: string };

export type AbortReason = "cancel" | "unload";

class AcquireError extends Error {}

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

async function checkFile(dir: string, file: ModelFile): Promise<ModelCheck> {
	const path = join(dir, file.name);
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) return { ok: false, message: `${file.name} is missing from ${dir}` };
	if (info.size !== file.bytes) return { ok: false, message: `${file.name} is ${info.size} bytes, expected ${file.bytes}` };
	if ((await sha256(path)) !== file.sha256) return { ok: false, message: `${file.name} does not match the published SHA-256 checksum` };
	return { ok: true };
}

export function installedModelDir(root: string, spec: EncoderSpec): string {
	return join(root, "models", spec.folderName);
}

export function downloadUrl(baseUrl: string, spec: EncoderSpec, file: ModelFile): string {
	return `${baseUrl}/${spec.id}/resolve/${spec.revision}/${file.path}`;
}

async function* readChunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		yield value;
	}
}

async function openSource(source: ModelSource, spec: EncoderSpec, file: ModelFile, start: number, signal: AbortSignal): Promise<{ offset: number; chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array> }> {
	if (source.kind === "folder") {
		const path = join(source.dir, file.name);
		const info = await stat(path).catch(() => null);
		if (!info?.isFile()) throw new AcquireError(`${file.name} is missing from ${source.dir}`);
		const offset = start <= info.size ? start : 0;
		return { offset, chunks: createReadStream(path, { start: offset }) as AsyncIterable<Uint8Array> };
	}
	const url = downloadUrl(source.baseUrl, spec, file);
	let response: Response;
	try {
		response = await fetch(url, { headers: start > 0 ? { range: `bytes=${start}-` } : {}, cache: "no-store", signal });
	} catch (error) {
		if (signal.aborted) throw error;
		throw new AcquireError(`Could not reach ${new URL(url).host}. Check the internet connection and retry, or import the files from a folder.`);
	}
	if (response.status === 416) return { offset: start, chunks: [] };
	if (!response.ok || !response.body) throw new AcquireError(`Downloading ${file.name} failed with HTTP ${response.status}.`);
	const resumed = response.status === 206 && response.headers.get("content-range")?.startsWith(`bytes ${start}-`);
	return { offset: resumed ? start : 0, chunks: readChunks(response.body) };
}

async function fetchFile(source: ModelSource, spec: EncoderSpec, file: ModelFile, staging: string, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<void> {
	const path = join(staging, file.name);
	const existing = (await stat(path).catch(() => null))?.size ?? 0;
	if (existing === file.bytes && (await sha256(path)) === file.sha256) return onBytes(file.bytes);
	const { offset, chunks } = await openSource(source, spec, file, existing < file.bytes ? existing : 0, signal);
	const handle = await open(path, offset === 0 ? "w" : "r+");
	try {
		await handle.truncate(offset);
		let position = offset;
		onBytes(position);
		for await (const chunk of chunks) {
			if (signal.aborted) throw signal.reason;
			await handle.write(chunk, 0, chunk.byteLength, position);
			position += chunk.byteLength;
			onBytes(position);
		}
	} catch (error) {
		if (signal.aborted) throw error;
		throw new AcquireError(`The transfer of ${file.name} stopped: ${error instanceof Error ? error.message : String(error)}. Retry continues where it stopped.`);
	} finally {
		await handle.close();
	}
	const check = await checkFile(staging, file);
	if (!check.ok) {
		await rm(path, { force: true });
		throw new AcquireError(check.message);
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function takeLock(path: string): Promise<() => Promise<void>> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(path, "wx");
			await handle.writeFile(String(process.pid));
			await handle.close();
			return () => rm(path, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = Number(await readFile(path, "utf8").catch(() => ""));
			if (owner > 0 && owner !== process.pid && alive(owner)) throw new AcquireError("Another Obsidian window is setting up the model. Wait for it to finish, then retry here.");
			await rm(path, { force: true });
		}
	}
	throw new AcquireError("Could not lock the model folder. Retry.");
}

// The partial folder keeps a fixed name so an interrupted transfer resumes after a restart.
export async function acquireModel(
	source: ModelSource,
	root: string,
	spec: EncoderSpec,
	signal: AbortSignal,
	onProgress: (doneBytes: number, totalBytes: number) => void,
): Promise<AcquireResult> {
	const files = [spec.model, spec.vocab];
	const total = files.reduce((n, f) => n + f.bytes, 0);
	const target = installedModelDir(root, spec);
	const staging = `${target}.partial`;
	await mkdir(join(root, "models"), { recursive: true });
	let unlock: (() => Promise<void>) | null = null;
	try {
		unlock = await takeLock(`${target}.lock`);
		await mkdir(staging, { recursive: true });
		let before = 0;
		for (const file of files) {
			await fetchFile(source, spec, file, staging, signal, (bytes) => onProgress(before + bytes, total));
			before += file.bytes;
		}
		await rm(target, { recursive: true, force: true });
		await rename(staging, target);
		return { kind: "installed" };
	} catch (error) {
		if (signal.aborted) {
			if ((signal.reason as AbortReason) === "cancel") await rm(staging, { recursive: true, force: true });
			return { kind: "cancelled" };
		}
		if (error instanceof AcquireError) return { kind: "failed", message: error.message };
		return { kind: "failed", message: `Setup failed: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		await unlock?.();
	}
}

export async function loadInstalledModel(root: string, spec: EncoderSpec): Promise<{ readonly model: Uint8Array; readonly vocab: string } | { readonly ok: false; readonly message: string }> {
	const dir = installedModelDir(root, spec);
	for (const file of [spec.model, spec.vocab]) {
		const check = await checkFile(dir, file);
		if (!check.ok) return check;
	}
	const model = await readFile(join(dir, spec.model.name));
	const standalone = model.byteOffset === 0 && model.byteLength === model.buffer.byteLength;
	return { model: standalone ? new Uint8Array(model.buffer) : new Uint8Array(model), vocab: await readFile(join(dir, spec.vocab.name), "utf8") };
}

export async function hasInstalledFiles(root: string, spec: EncoderSpec): Promise<boolean> {
	return (await stat(installedModelDir(root, spec)).catch(() => null))?.isDirectory() ?? false;
}
