import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { E5_SMALL_V2 } from "../src/core/encoder-spec.ts";
import type { TokenId } from "../src/core/tokenizer.ts";
import { type QueryGeneration, type SearchResponse, type SourceFile, VAULT_COLLECTION } from "../src/core/types.ts";
import { Engine } from "../src/worker/engine.ts";
import type { FromWorker } from "../src/worker/protocol.ts";

const vocab = readFileSync("dev-assets/e5-small-v2/vocab.txt", "utf8");

function bagOfTokens(input: readonly TokenId[]): Float32Array {
	const v = new Float32Array(E5_SMALL_V2.dimensions);
	for (const id of input.slice(3, -1)) v[id % v.length]! += 1;
	const norm = Math.hypot(...v) || 1;
	return v.map((x) => x / norm);
}

function harness(embedDelayMs = 0) {
	const messages: FromWorker[] = [];
	const embedded: string[] = [];
	const embedsAtResponse: number[] = [];
	const engine = new Engine({
		spec: E5_SMALL_V2,
		snapshotDelayMs: 5,
		post: (m) => {
			if (m.type === "response") embedsAtResponse.push(embedded.length);
			messages.push(m);
		},
		createEncoder: async () => ({
			async embed(input) {
				embedded.push(input.join(","));
				if (embedDelayMs) await sleep(embedDelayMs);
				return bagOfTokens(input);
			},
			async dispose() {},
		}),
	});
	const responses = () => messages.flatMap((m) => (m.type === "response" ? [m.response] : []));
	const lastState = () => messages.filter((m) => m.type === "state").at(-1);
	const search = (generation: number, text: string) => engine.handle({ type: "search", request: { generation: generation as QueryGeneration, text, limit: 5 } });
	return { engine, messages, embedded, embedsAtResponse, responses, lastState, search };
}

const file = (path: string, text: string): SourceFile => ({ collectionId: VAULT_COLLECTION, path, text, aliases: [] });
const paths = (r: SearchResponse | undefined) => (r?.kind === "results" ? r.files.map((f) => f.path) : r?.kind);

test("answers not-ready before a model is loaded, and empty for blank input", async () => {
	const h = harness();
	h.engine.handle({ type: "sync", files: [file("a.md", "# A\n\nsourdough bread")], complete: true });
	await h.engine.idle();
	h.search(1, "bread");
	h.search(2, "   ");
	await h.engine.idle();
	assert.deepEqual(h.responses(), [
		{ kind: "not-ready", generation: 1, label: "model-needed", coverage: { embeddedSources: 0, totalSources: 1 } },
		{ kind: "empty", generation: 2 },
	]);
});

test("indexes after the model loads and ranks the matching note first", async () => {
	const h = harness();
	h.engine.handle({ type: "sync", files: [file("bread.md", "# Bread\n\nsourdough starter feeding"), file("tax.md", "# Tax\n\nreceipts and quarterly payments")], complete: true });
	h.engine.handle({ type: "load-model", model: new Uint8Array(), vocab });
	await h.engine.idle();
	h.search(1, "sourdough starter");
	await h.engine.idle();
	assert.deepEqual(paths(h.responses()[0]), ["bread.md", "tax.md"]);
	assert.deepEqual(h.lastState(), { type: "state", model: { kind: "loaded" }, coverage: { embeddedSources: 2, totalSources: 2 }, indexGeneration: 3 });
});

test("keeps only the newest pending query while background work runs", async () => {
	const h = harness(15);
	const many = Array.from({ length: 6 }, (_, i) => file(`n${i}.md`, `# N${i}\n\npassage number ${i} about gardening`));
	h.engine.handle({ type: "load-model", model: new Uint8Array(), vocab });
	h.engine.handle({ type: "sync", files: many, complete: true });
	await sleep(40);
	h.search(1, "first");
	h.search(2, "second");
	h.search(3, "third");
	const before = h.embedded.length;
	await h.engine.idle();
	assert.deepEqual(h.responses().map((r) => r.generation), [3]);
	const embedsUntilAnswer = h.embedsAtResponse[0]! - before;
	assert.ok([1, 2].includes(embedsUntilAnswer), `at most one background embed before the query, saw ${embedsUntilAnswer - 1}`);
	assert.equal(h.embedded.length, 7, "six passages plus one query");
});

test("retires an edited note until its new revision is embedded, reusing unchanged passages", async () => {
	const h = harness(10);
	h.engine.handle({ type: "load-model", model: new Uint8Array(), vocab });
	h.engine.handle({ type: "sync", files: [file("plan.md", "# Plan\n\nalpha section text\n\n## Two\n\nbeta section text")], complete: true });
	await h.engine.idle();
	const firstPass = h.embedded.length;
	h.engine.handle({ type: "sync", files: [file("plan.md", "# Plan\n\nalpha section text\n\n## Two\n\ngamma replaced text")], complete: true });
	await sleep(1);
	h.search(1, "alpha");
	await h.engine.idle();
	assert.deepEqual(paths(h.responses()[0]), []);
	h.search(2, "gamma");
	await h.engine.idle();
	assert.deepEqual(paths(h.responses()[1]), ["plan.md"]);
	assert.equal(firstPass, 2);
	assert.equal(h.embedded.length - firstPass, 3, "one new passage plus two queries");
});

test("a complete sync removes notes that no longer exist", async () => {
	const h = harness();
	h.engine.handle({ type: "load-model", model: new Uint8Array(), vocab });
	h.engine.handle({ type: "sync", files: [file("keep.md", "# Keep\n\nkeep text"), file("gone.md", "# Gone\n\ngone text")], complete: true });
	await h.engine.idle();
	h.engine.handle({ type: "sync", files: [file("keep.md", "# Keep\n\nkeep text")], complete: true });
	await h.engine.idle();
	h.search(1, "gone text");
	await h.engine.idle();
	assert.deepEqual(paths(h.responses()[0]), ["keep.md"]);
});

test("restores a snapshot without re-embedding unchanged notes", async () => {
	const first = harness();
	first.engine.handle({ type: "load-model", model: new Uint8Array(), vocab });
	first.engine.handle({ type: "sync", files: [file("a.md", "# A\n\nsourdough starter"), file("b.md", "# B\n\nquarterly taxes")], complete: true });
	await first.engine.idle();
	await sleep(20);
	const snapshot = first.messages.find((m) => m.type === "snapshot");
	assert.equal(snapshot?.type, "snapshot");
	if (snapshot?.type !== "snapshot") return;

	const second = harness();
	second.engine.handle({ type: "restore", meta: snapshot.meta, vectors: snapshot.vectors });
	second.engine.handle({ type: "load-model", model: new Uint8Array(), vocab });
	second.engine.handle({ type: "sync", files: [file("a.md", "# A\n\nsourdough starter"), file("b.md", "# B\n\nquarterly taxes")], complete: true });
	await second.engine.idle();
	second.search(1, "sourdough");
	await second.engine.idle();
	assert.deepEqual(paths(second.responses()[0]), ["a.md", "b.md"]);
	assert.equal(second.embedded.length, 1, "only the query was embedded");
});
