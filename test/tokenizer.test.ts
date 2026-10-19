import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createWordPieceTokenizer } from "../src/core/tokenizer.ts";

const vocabPath = "dev-assets/e5-small-v2/vocab.txt";
const rows: { text: string; ids: number[] }[] = JSON.parse(readFileSync("test/fixtures/tokenizer-reference.json", "utf8"));

test("matches Hugging Face tokenizers on the reference corpus", () => {
	const tokenizer = createWordPieceTokenizer(readFileSync(vocabPath, "utf8"), { lowercase: true });
	const mismatches = rows.filter((row) => JSON.stringify(tokenizer.encode(row.text)) !== JSON.stringify(row.ids));
	assert.deepEqual(
		mismatches.slice(0, 3).map((row) => ({ text: row.text, expected: row.ids, actual: tokenizer.encode(row.text) })),
		[],
	);
	assert.equal(rows.length, 491);
});

test("splits punctuation and marks unknown long words", () => {
	const tokenizer = createWordPieceTokenizer(readFileSync(vocabPath, "utf8"), { lowercase: true });
	assert.deepEqual(tokenizer.encode("Café x" + "y".repeat(100)), [7668, 100]);
	assert.deepEqual(tokenizer.encode("cache-key"), [17053, 1011, 3145]);
});
