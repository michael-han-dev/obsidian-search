import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { E5_SMALL_V2 } from "../src/core/encoder-spec.ts";
import type { TokenId } from "../src/core/tokenizer.ts";
import { createOrtEncoder } from "../src/worker/ort-encoder.ts";

test("the bundled WASM runtime matches Python onnxruntime embeddings", async () => {
	const reference: { rows: { ids: number[]; embedding: number[] }[] } = JSON.parse(readFileSync("test/fixtures/reference-embeddings.json", "utf8"));
	const wasm = readFileSync("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm");
	const encoder = await createOrtEncoder(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), readFileSync("dev-assets/e5-small-v2/model.onnx"), E5_SMALL_V2);
	let worst = 0;
	for (const row of reference.rows) {
		const vector = await encoder.embed(row.ids as TokenId[]);
		for (let d = 0; d < E5_SMALL_V2.dimensions; d++) worst = Math.max(worst, Math.abs(vector[d]! - row.embedding[d]!));
	}
	await encoder.dispose();
	assert.equal(reference.rows.length, 8);
	assert.ok(worst < 1e-5, `largest difference ${worst}`);
});
