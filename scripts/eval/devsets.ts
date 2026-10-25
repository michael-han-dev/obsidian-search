// Usage: node scripts/eval/devsets.ts [modelsDir] [out] [candidates,...]
// The standalone evaluation host: the plugin's own extraction, passages, filters, and exact search, run per candidate.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EncoderSpec } from "../../src/core/encoder-spec.ts";
import { embeddingFingerprint, encodeQuery } from "../../src/core/encoder-spec.ts";
import { compileFilter } from "../../src/core/filter.ts";
import { extractDocument } from "../../src/core/markdown.ts";
import { noteMetadata } from "../../src/core/metadata.ts";
import { buildPassages, type PassagePolicy } from "../../src/core/passages.ts";
import { parseQuery } from "../../src/core/query.ts";
import { type IndexedSource, searchExact } from "../../src/core/search.ts";
import { createWordPieceTokenizer } from "../../src/core/tokenizer.ts";
import { type SourceDocument, VAULT_COLLECTION } from "../../src/core/types.ts";
import { createOrtEncoder } from "../../src/worker/ort-encoder.ts";
import { EVERYDAY_NOTES, EVERYDAY_SEARCHES } from "../../test/fixtures/everyday.ts";
import { NO_MATCH_ELSEWHERE, PARAPHRASE_NOTES, PARAPHRASE_SEARCHES } from "../../test/fixtures/paraphrase.ts";
import { NOTES, noteText, QUERIES } from "../../test/fixtures/vault.ts";

const models = process.argv[2] ?? "dev-assets/models";
const out = process.argv[3] ?? "dev-assets/m3/eval/devsets.json";
const only = process.argv[4]?.split(",");
const POLICIES: PassagePolicy[] = [
	{ maxInputTokens: 80, maxContextTokens: 32 },
	{ maxInputTokens: 96, maxContextTokens: 32 },
	{ maxInputTokens: 112, maxContextTokens: 32 },
	{ maxInputTokens: 176, maxContextTokens: 32 },
	{ maxInputTokens: 256, maxContextTokens: 32 },
];

function frontmatter(text: string): Record<string, unknown> {
	const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
	const fields: Record<string, unknown> = {};
	for (const line of m?.[1]?.split("\n") ?? []) {
		const kv = /^(\w+):\s*(.*)$/.exec(line);
		if (!kv) continue;
		const value = kv[2]!.trim();
		fields[kv[1]!] = value.startsWith("[") ? value.slice(1, -1).split(",").map((v) => v.trim()) : value;
	}
	return fields;
}

const vaults: Record<string, { path: string; text: string; aliases: readonly string[]; tags: readonly string[]; fields: Record<string, unknown> }[]> = {
	fixture: NOTES.map((n) => ({ path: n.path, text: noteText(n), aliases: n.aliases ?? [], tags: n.tags ?? [], fields: {} })),
	everyday: Object.entries(EVERYDAY_NOTES).map(([path, text]) => {
		const fields = frontmatter(text);
		return { path, text, aliases: [], tags: (fields.tags as string[] | undefined) ?? [], fields };
	}),
	paraphrase: Object.entries(PARAPHRASE_NOTES).map(([path, text]) => ({ path, text, aliases: [], tags: [], fields: {} })),
};

interface Case {
	readonly vault: string;
	readonly query: string;
	readonly kind: "ranked" | "paraphrase" | "literal" | "no-match";
	readonly top?: string | undefined;
	readonly passage?: string | undefined;
	readonly absent?: string | undefined;
}

const cases: Case[] = [
	...QUERIES.map((q): Case => ({ vault: "fixture", query: q.text, kind: "ranked", top: q.expectedSource })),
	...EVERYDAY_SEARCHES.filter((s) => s.kind === "results").map((s): Case => ({ vault: "everyday", query: s.query, kind: "ranked", top: s.top!, absent: s.absent?.[0] })),
	...PARAPHRASE_SEARCHES.map((s): Case => ({ vault: "paraphrase", ...s, absent: s.kind === "literal" ? s.absent : undefined })),
	...NO_MATCH_ELSEWHERE.fixture.map((query): Case => ({ vault: "fixture", query, kind: "no-match" })),
	...NO_MATCH_ELSEWHERE.everyday.map((query): Case => ({ vault: "everyday", query, kind: "no-match" })),
];

interface Manifest {
	name: string;
	repo: string;
	revision: string;
	onnx: string;
	queryPrefix: string;
	passagePrefix: string;
	files: Record<string, { bytes: number; sha256: string }>;
}

async function specOf(c: Manifest): Promise<EncoderSpec> {
	const dir = join(models, c.name);
	const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
	const pooling = JSON.parse(await readFile(join(dir, "1_Pooling", "config.json"), "utf8"));
	return {
		id: c.repo,
		revision: c.revision,
		license: "",
		folderName: c.name,
		model: { name: c.onnx, path: c.onnx, ...c.files[c.onnx]! },
		vocab: { name: "vocab.txt", path: "vocab.txt", ...c.files["vocab.txt"]! },
		dimensions: config.hidden_size,
		maxTokens: 512,
		queryPrefix: c.queryPrefix,
		passagePrefix: c.passagePrefix,
		output: outputs[c.name]!.includes("last_hidden_state") ? "last_hidden_state" : "token_embeddings",
		pooling: pooling.pooling_mode_cls_token ? "cls" : "mean",
		normalize: true,
		lowercase: true,
		precision: "fp32",
		templateRevision: "eval",
		relevanceThreshold: 0,
	};
}

const wasm = (await readFile("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm")).buffer as ArrayBuffer;
const manifest: Manifest[] = JSON.parse(await readFile(join(models, "manifest.json"), "utf8"));
const outputs: Record<string, string[]> = Object.fromEntries(JSON.parse(await readFile("dev-assets/m3/eval/runtime.json", "utf8")).map((r: { name: string; outputs: string[] }) => [r.name, r.outputs]));
const results: Record<string, unknown> = JSON.parse(await readFile(out, "utf8").catch(() => "{}"));

for (const c of manifest.filter((m) => !only || only.includes(m.name))) {
	const spec = await specOf(c);
	const fingerprint = await embeddingFingerprint(spec);
	const tokenizer = createWordPieceTokenizer(await readFile(join(models, c.name, "vocab.txt"), "utf8"), { lowercase: true });
	const encoder = await createOrtEncoder(wasm, new Uint8Array(await readFile(join(models, c.name, c.onnx))), spec);
	const byPolicy: Record<string, unknown> = {};
	for (const policy of POLICIES) {
		const started = performance.now();
		const indexed: Record<string, IndexedSource[]> = {};
		let passages = 0;
		for (const [vault, notes] of Object.entries(vaults)) {
			indexed[vault] = [];
			for (const note of notes) {
				const doc: SourceDocument = await extractDocument({
					collectionId: VAULT_COLLECTION,
					path: note.path,
					text: note.text,
					metadata: noteMetadata({ aliases: note.aliases, tags: note.tags, frontmatter: note.fields }),
				});
				const work = await buildPassages(doc, tokenizer, spec, fingerprint, policy);
				const vectors = new Float32Array(work.length * spec.dimensions);
				for (let i = 0; i < work.length; i++) vectors.set(await encoder.embed(work[i]!.input), i * spec.dimensions);
				passages += work.length;
				indexed[vault]!.push({ doc, passages: work.map((w) => w.passage), vectors });
			}
		}
		const indexMs = performance.now() - started;
		const rows = [];
		for (const k of cases) {
			const parsed = parseQuery(k.query);
			if (!parsed.ok) throw new Error(`${k.query}: ${parsed.error}`);
			const filter = compileFilter(parsed.query.constraints);
			const vector = await encoder.embed(encodeQuery(tokenizer, spec, parsed.query.relevance));
			const files = searchExact(indexed[k.vault]!.filter((s) => filter(s.doc)), vector, 20);
			const rank = k.top ? files.findIndex((f) => f.path === k.top) + 1 : 0;
			const expected = files.find((f) => f.path === k.top);
			rows.push({
				vault: k.vault,
				kind: k.kind,
				query: k.query,
				rank,
				topScore: files[0]?.score ?? null,
				top: files[0]?.path ?? null,
				expectedScore: expected?.score ?? null,
				passageHit: k.passage ? !!expected?.passages[0]?.text.includes(k.passage) : null,
				passage: expected?.passages[0]?.text ?? null,
				absentShown: k.absent ? files.some((f) => f.path === k.absent) : null,
				second: files[1] ? { path: files[1].path, score: files[1].score } : null,
			});
		}
		const ranked = rows.filter((r) => r.kind !== "no-match");
		const summary = {
			passages,
			indexMs: Math.round(indexMs),
			top1: ranked.filter((r) => r.rank === 1).length,
			of: ranked.length,
			mrr: Number((ranked.reduce((n, r) => n + (r.rank > 0 ? 1 / r.rank : 0), 0) / ranked.length).toFixed(4)),
			passageHits: rows.filter((r) => r.passageHit === true).length,
			passageCases: rows.filter((r) => r.passageHit !== null).length,
			minExpectedScore: Math.min(...ranked.filter((r) => r.rank === 1).map((r) => r.expectedScore!)),
			maxNoMatchScore: Math.max(...rows.filter((r) => r.kind === "no-match").map((r) => r.topScore!)),
			misses: ranked.filter((r) => r.rank !== 1).map((r) => `${r.rank}:${r.query}`),
		};
		byPolicy[policy.maxInputTokens] = { summary, rows };
		console.log(c.name, policy.maxInputTokens, JSON.stringify(summary));
	}
	await encoder.dispose();
	results[c.name] = byPolicy;
	await writeFile(out, `${JSON.stringify(results, null, 1)}\n`);
}
