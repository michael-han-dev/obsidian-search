import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { EncoderSpec, ModelFile } from "../core/encoder-spec.ts";

export type ModelCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

async function sha256(path: string, onBytes?: (n: number) => void): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer);
		onBytes?.((chunk as Buffer).byteLength);
	}
	return hash.digest("hex");
}

async function checkFile(dir: string, file: ModelFile, onBytes?: (n: number) => void): Promise<ModelCheck> {
	const path = join(dir, file.name);
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) return { ok: false, message: `${file.name} is missing from ${dir}` };
	if (info.size !== file.bytes) return { ok: false, message: `${file.name} is ${info.size} bytes, expected ${file.bytes}` };
	if ((await sha256(path, onBytes)) !== file.sha256) return { ok: false, message: `${file.name} does not match the published SHA-256 checksum` };
	return { ok: true };
}

export function installedModelDir(root: string, spec: EncoderSpec): string {
	return join(root, "models", spec.folderName);
}

export async function importModel(
	sourceDir: string,
	root: string,
	spec: EncoderSpec,
	onProgress: (doneBytes: number, totalBytes: number) => void,
): Promise<ModelCheck> {
	const files = [spec.model, spec.vocab];
	const total = files.reduce((n, f) => n + f.bytes, 0);
	const target = installedModelDir(root, spec);
	const staging = `${target}.partial-${randomUUID()}`;
	let done = 0;
	try {
		await mkdir(staging, { recursive: true });
		for (const file of files) {
			const source = await stat(join(sourceDir, file.name)).catch(() => null);
			if (!source?.isFile()) return { ok: false, message: `${file.name} is missing from ${sourceDir}` };
			await copyFile(join(sourceDir, file.name), join(staging, file.name));
			const check = await checkFile(staging, file, (n) => onProgress((done += n), total));
			if (!check.ok) return check;
		}
		await rm(target, { recursive: true, force: true });
		await rename(staging, target);
		return { ok: true };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

export async function loadInstalledModel(root: string, spec: EncoderSpec): Promise<{ model: Uint8Array; vocab: string } | ModelCheck> {
	const dir = installedModelDir(root, spec);
	for (const file of [spec.model, spec.vocab]) {
		const check = await checkFile(dir, file);
		if (!check.ok) return check;
	}
	const model = await readFile(join(dir, spec.model.name));
	const standalone = model.byteOffset === 0 && model.byteLength === model.buffer.byteLength;
	return { model: standalone ? new Uint8Array(model.buffer) : new Uint8Array(model), vocab: await readFile(join(dir, spec.vocab.name), "utf8") };
}
