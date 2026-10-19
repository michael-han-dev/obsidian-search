import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { digest } from "../core/hash.ts";

export function dataRoot(platform: string = process.platform, env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
	if (env.DOWSE_DATA_DIR) return env.DOWSE_DATA_DIR;
	if (platform === "darwin") return join(home, "Library", "Application Support", "dowse");
	if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "dowse");
	return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "dowse");
}

export async function vaultIndexDir(root: string, vaultBasePath: string): Promise<string> {
	const canonical = await realpath(vaultBasePath);
	const hash = (await digest(canonical)).slice("blake3:".length, "blake3:".length + 16);
	const name = basename(canonical).replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 40) || "vault";
	return join(root, "vaults", `${name}-${hash}`);
}

const META = "index.json";

export async function readIndex(dir: string): Promise<{ meta: string; vectors: Float32Array } | null> {
	let pointer: { vectors: string; meta: string };
	try {
		pointer = JSON.parse(await readFile(join(dir, META), "utf8"));
	} catch {
		return null;
	}
	if (typeof pointer.vectors !== "string" || typeof pointer.meta !== "string" || !/^vectors-[\w-]+\.f32$/.test(pointer.vectors)) return null;
	try {
		const bytes = await readFile(join(dir, pointer.vectors));
		if (bytes.byteLength % 4 !== 0) return null;
		return { meta: pointer.meta, vectors: new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
	} catch {
		return null;
	}
}

// The vectors file is written under a fresh name before index.json is replaced,
// so index.json always names a complete vectors file even after a crash.
export async function writeIndex(dir: string, meta: string, vectors: Float32Array): Promise<void> {
	await mkdir(dir, { recursive: true });
	const id = randomUUID();
	const vectorsName = `vectors-${id}.f32`;
	await writeFile(join(dir, vectorsName), new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength));
	await writeFile(join(dir, `${META}.${id}.tmp`), JSON.stringify({ vectors: vectorsName, meta }));
	await rename(join(dir, `${META}.${id}.tmp`), join(dir, META));
	for (const name of await readdir(dir)) {
		if ((name.startsWith("vectors-") && name !== vectorsName) || name.endsWith(".tmp")) await rm(join(dir, name), { force: true });
	}
}

export async function deleteAllLocalData(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}
