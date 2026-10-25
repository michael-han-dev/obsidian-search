// Usage: node scripts/fetch-dev-model.ts [dir]
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENCODER } from "../src/core/encoder-spec.ts";

const out = process.argv[2] ?? "dev-assets/model";
const base = `https://huggingface.co/${ENCODER.id}/resolve/${ENCODER.revision}`;
const files: [string, string, string | null][] = [
	[ENCODER.model.name, ENCODER.model.path, ENCODER.model.sha256],
	[ENCODER.vocab.name, ENCODER.vocab.path, ENCODER.vocab.sha256],
	["tokenizer.json", "tokenizer.json", null],
	["config.json", "config.json", null],
	["1_Pooling/config.json", "1_Pooling/config.json", null],
];
for (const [name, path, sha256] of files) {
	const target = join(out, name);
	if (!(await stat(target).catch(() => null))?.size) {
		const response = await fetch(`${base}/${path}`);
		if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, new Uint8Array(await response.arrayBuffer()));
	}
	const digest = createHash("sha256").update(await readFile(target)).digest("hex");
	if (sha256 && digest !== sha256) throw new Error(`${name}: sha256 ${digest} does not match ${sha256}`);
	console.log(name, sha256 ? "verified" : digest);
}
