import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { E5_SMALL_V2 } from "../src/core/encoder-spec.ts";
import { digest } from "../src/core/hash.ts";
import { extractDocument, parseMarkdownBlocks } from "../src/core/markdown.ts";
import { buildPassages } from "../src/core/passages.ts";
import { createWordPieceTokenizer } from "../src/core/tokenizer.ts";
import { type CollectionId, VAULT_COLLECTION } from "../src/core/types.ts";
import { NOTES, noteText } from "./fixtures/vault.ts";

const note = (path: string) => noteText(NOTES.find((n) => n.path === path)!);
const tokenizer = createWordPieceTokenizer(readFileSync("dev-assets/e5-small-v2/vocab.txt", "utf8"), { lowercase: true });

test("BLAKE3 digests match the official test vectors", async () => {
	const vectors: { input_len: number; hash: string }[] = JSON.parse(readFileSync("test/fixtures/blake3-vectors.json", "utf8"));
	for (const { input_len, hash } of vectors) {
		const input = Uint8Array.from({ length: input_len }, (_, i) => i % 251);
		assert.equal(await digest(input), `blake3:${hash}`, `input_len ${input_len}`);
	}
	assert.equal(vectors.length, 11);
});

test("skips frontmatter and tracks heading paths and one-based lines", () => {
	const blocks = parseMarkdownBlocks(note("Engineering/API reliability.md"));
	assert.deepEqual(
		blocks.map((b) => ({ headingPath: b.headingPath, span: b.span, starts: b.text.slice(0, 13) })),
		[
			{ headingPath: ["API reliability", "Retries"], span: { start: { line: 9, column: 0 }, end: { line: 9, column: 264 } }, starts: "Clients retry" },
			{ headingPath: ["API reliability", "Timeouts"], span: { start: { line: 13, column: 0 }, end: { line: 13, column: 84 } }, starts: "Set the clien" },
		],
	);
});

test("keeps fenced code together and ignores heading markers inside it", () => {
	const blocks = parseMarkdownBlocks(note("Engineering/C++ templates.md"));
	assert.deepEqual(
		blocks.map((b) => [b.headingPath, b.span.start.line, b.span.end.line, b.span.end.column]),
		[
			[["C++ templates"], 3, 3, 145],
			[["C++ templates"], 5, 8, 3],
			[["C++ templates"], 10, 10, 59],
		],
	);
	assert.match(blocks[1]!.text, /^```cpp\n# not a heading inside code\n/);
});

test("counts columns in UTF-16 units across CRLF line endings", () => {
	const text = note("Notes/Café résumé.md");
	assert.ok(text.includes("\r\n"));
	const [block] = parseMarkdownBlocks(text);
	assert.deepEqual(block!.span, { start: { line: 3, column: 0 }, end: { line: 3, column: 177 } });
	assert.deepEqual(block!.headingPath, ["Café résumé"]);
});

test("extracts a document with path identity, title, and content revision", async () => {
	const text = note("People/Ada Lovelace.md");
	const doc = await extractDocument({ collectionId: VAULT_COLLECTION, path: "People/Ada Lovelace.md", text, aliases: ["Countess of Lovelace"] });
	assert.equal(doc.sourceId, "People/Ada Lovelace.md");
	assert.equal(doc.title, "Ada Lovelace");
	assert.equal(doc.revision, await digest(text));
	assert.notEqual(doc.revision, await digest(text + " "));
	assert.equal(doc.collectionId, "vault" as CollectionId);
	assert.deepEqual(doc.blocks.map((b) => b.span.start.line), [8]);
});

test("builds one passage per section with title, alias, and heading context", async () => {
	const doc = await extractDocument({ collectionId: VAULT_COLLECTION, path: "Engineering/Incident handbook.md", text: note("Engineering/Incident handbook.md"), aliases: [] });
	const passages = await buildPassages(doc, tokenizer, E5_SMALL_V2);
	assert.deepEqual(
		passages.map((p) => [p.passage.id, p.passage.headingPath.at(-1), p.passage.span.start.line, p.passage.truncated]),
		[
			["Engineering/Incident handbook.md#0", "Severity levels", 5, false],
			["Engineering/Incident handbook.md#1", "Escalation", 9, false],
			["Engineering/Incident handbook.md#2", "Postmortems", 13, false],
		],
	);
	const words = tokenizer.encode("passage: Incident handbook Incident handbook > Escalation");
	assert.deepEqual(passages[1]!.input.slice(0, words.length + 1), [tokenizer.clsId, ...words]);
	assert.equal(passages[1]!.input.at(-1), tokenizer.sepId);
});

test("splits an oversized block by lines and marks a single oversized line as truncated", async () => {
	const long = "word ".repeat(300).trim();
	const text = `# Big\n\nshort first line\n${long}\n`;
	const doc = await extractDocument({ collectionId: VAULT_COLLECTION, path: "Big.md", text, aliases: [] });
	const passages = await buildPassages(doc, tokenizer, E5_SMALL_V2);
	assert.deepEqual(
		passages.map((p) => [p.passage.span.start.line, p.passage.span.end.line, p.passage.truncated, p.input.length]),
		[
			[3, 3, false, 9],
			[4, 4, true, 112],
		],
	);
});
