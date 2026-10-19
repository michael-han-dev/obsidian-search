import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { NOTES, noteText } from "../test/fixtures/vault.ts";

const target = resolve(process.argv[2] ?? "dev-assets/fixture-vault");
await rm(target, { recursive: true, force: true });
for (const note of NOTES) {
	const file = join(target, note.path);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, noteText(note));
}
console.log(`wrote ${NOTES.length} notes to ${target}`);
