import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { E5_SMALL_V2, encodeQuery } from "../src/core/encoder-spec.ts";
import { extractDocument } from "../src/core/markdown.ts";
import { buildPassages } from "../src/core/passages.ts";
import { type IndexedSource, meanPoolNormalized, searchExact } from "../src/core/search.ts";
import { createWordPieceTokenizer } from "../src/core/tokenizer.ts";
import { type Digest, type Passage, type PassageId, type SourceId, VAULT_COLLECTION } from "../src/core/types.ts";
import { createOrtEncoder } from "../src/worker/ort-encoder.ts";
import { NOTES, noteText, QUERIES } from "./fixtures/vault.ts";

const span = { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };
const passage = (source: string, n: number): Passage => ({
	id: `${source}#${n}` as PassageId,
	sourceId: source as SourceId,
	revision: "blake3:r" as Digest,
	headingPath: [],
	text: `${source} ${n}`,
	span,
	truncated: false,
	inputHash: "blake3:i" as Digest,
});
const source = (path: string, vectors: number[][]): IndexedSource => ({
	sourceId: path as SourceId,
	path,
	title: path,
	revision: "blake3:r" as Digest,
	passages: vectors.map((_, i) => passage(path, i)),
	vectors: Float32Array.from(vectors.flat()),
});

test("mean pooling averages token rows and normalizes to unit length", () => {
	assert.deepEqual(Array.from(meanPoolNormalized(Float32Array.from([3, 0, 0, 4]), 2, 2)), [0.6000000238418579, 0.800000011920929]);
});

test("ranks files by their best passage and keeps that file's top passages", () => {
	const results = searchExact(
		[source("a.md", [[1, 0], [0.6, 0.8], [0, 1]]), source("b.md", [[0.8, 0.6]]), source("empty.md", [])],
		Float32Array.from([0, 1]),
		5,
		2,
	);
	assert.deepEqual(
		results.map((f) => [f.path, f.score.toFixed(2), f.passages.map((p) => p.passageId)]),
		[
			["a.md", "1.00", ["a.md#2", "a.md#1"]],
			["b.md", "0.60", ["b.md#0"]],
		],
	);
});

test("finds the expected note for each fixture paraphrase with the real model", async () => {
	const vocab = readFileSync("dev-assets/e5-small-v2/vocab.txt", "utf8");
	const tokenizer = createWordPieceTokenizer(vocab, { lowercase: true });
	const wasm = readFileSync("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm");
	const encoder = await createOrtEncoder(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), readFileSync("dev-assets/e5-small-v2/model.onnx"), E5_SMALL_V2);
	const sources: IndexedSource[] = [];
	for (const note of NOTES) {
		const doc = await extractDocument({ collectionId: VAULT_COLLECTION, path: note.path, text: noteText(note), aliases: note.aliases ?? [] });
		const encodable = await buildPassages(doc, tokenizer, E5_SMALL_V2);
		const vectors = new Float32Array(encodable.length * E5_SMALL_V2.dimensions);
		for (const [i, { input }] of encodable.entries()) vectors.set(await encoder.embed(input), i * E5_SMALL_V2.dimensions);
		sources.push({ sourceId: doc.sourceId, path: doc.path, title: doc.title, revision: doc.revision, passages: encodable.map((e) => e.passage), vectors });
	}
	const ranks: { query: string; rank: number; heading: string | undefined }[] = [];
	for (const query of QUERIES) {
		const results = searchExact(sources, await encoder.embed(encodeQuery(tokenizer, E5_SMALL_V2, query.text)), 5);
		const rank = results.findIndex((f) => f.path === query.expectedSource) + 1;
		const best = results[rank - 1]?.passages[0];
		ranks.push({ query: query.text, rank, heading: query.expectedHeading ? best?.headingPath.at(-1) : undefined });
	}
	await encoder.dispose();
	console.log(JSON.stringify(ranks));
	assert.deepEqual(
		ranks.filter((r) => r.rank < 1 || r.rank > 3),
		[],
	);
	assert.deepEqual(
		QUERIES.filter((q) => q.expectedHeading).map((q) => ranks.find((r) => r.query === q.text)!.heading),
		QUERIES.filter((q) => q.expectedHeading).map((q) => q.expectedHeading),
	);
	assert.equal(ranks.length, 14);
});
