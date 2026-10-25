// Usage: node scripts/live/manifest.ts <load report> [out]
// Freezes the supported-device resource manifest from measured reports.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { ENCODER, embeddingFingerprint } from "../../src/core/encoder-spec.ts";
import { PASSAGE_POLICY } from "../../src/core/passages.ts";

const loadPath = process.argv[2] ?? "dev-assets/load/results/m3.json";
const outPath = process.argv[3] ?? "dev-assets/m3/resource-manifest.json";
const load = JSON.parse(await readFile(loadPath, "utf8"));
const core = JSON.parse(await readFile("dev-assets/live/results/report.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const memory = load["renderer physical footprint mb"];

const manifest = {
	frozenAt: new Date().toISOString(),
	sources: { load: loadPath, core: "dev-assets/live/results/report.json" },
	device: {
		cpu: sh("sysctl", ["-n", "machdep.cpu.brand_string"]),
		cores: Number(sh("sysctl", ["-n", "hw.ncpu"])),
		memoryGb: Number(sh("sysctl", ["-n", "hw.memsize"])) / 2 ** 30,
		macos: `${sh("sw_vers", ["-productVersion"])} (${sh("sw_vers", ["-buildVersion"])})`,
		arch: process.arch,
	},
	host: core.versions,
	model: {
		id: ENCODER.id,
		revision: ENCODER.revision,
		license: ENCODER.license,
		source: `https://huggingface.co/${ENCODER.id}/tree/${ENCODER.revision}`,
		files: [ENCODER.model, ENCODER.vocab],
		dimensions: ENCODER.dimensions,
		pooling: ENCODER.pooling,
		output: ENCODER.output,
		normalize: ENCODER.normalize,
		precision: ENCODER.precision,
		queryPrefix: ENCODER.queryPrefix,
		passagePrefix: ENCODER.passagePrefix,
		templateRevision: ENCODER.templateRevision,
		relevanceThreshold: ENCODER.relevanceThreshold,
		fingerprint: await embeddingFingerprint(ENCODER),
	},
	runtime: {
		package: `onnxruntime-web@${pkg.devDependencies["onnxruntime-web"]}`,
		backend: "wasm, ort-wasm-simd-threaded.wasm, bundled gzip in main.js",
		intraOpThreads: 1,
		interOpThreads: "none: the WASM backend has no inter-op pool",
		threadLimit: "onnxruntime-web forces one thread unless self.crossOriginIsolated, which Obsidian's workers report false",
		sessionOwner: "one encoder worker inside the engine worker; terminated after the idle interval",
		maxLiveSessions: 1,
	},
	batching: {
		passagesPerInferenceCall: 1,
		maxInputTokens: PASSAGE_POLICY.maxInputTokens,
		maxContextTokens: PASSAGE_POLICY.maxContextTokens,
		passageInferenceMs: load["background passage inference ms"],
		queryEmbeddingMs: load["query embedding ms"],
		interactivePriority: "a pending search runs before the next passage",
	},
	idleRelease: { defaultMs: 300_000, measuredWithMs: load.run.idleMs },
	memoryMb: memory,
	bytes: { model: load["model bytes"], index1000Notes: load["index bytes"], vault: load.vault },
	latencyMs: {
		coldEnableToModelLoaded: load["enable to model loaded ms, cold"],
		enableToFullyIndexed1000Notes: load["enable to ready ms"],
		restart: load.restart,
		typedToResultsWarm: load["typed query to visible results ms"],
		typedToResultsWhileIndexing: load["typed query to visible results while indexing ms"],
		typedToResultsAfterIdleRelease: load["typed query after idle release to visible results ms"],
		queryEmbedding: load["query embedding ms"],
		filterOnlyTypedToResults: load["filter-only typed to visible results ms"],
		saveToSearchable: load["save to searchable ms"],
	},
	counters: { afterIndexing: load["counters after indexing"], afterIdleCycles: load["counters after idle cycles"] },
	budgets: {
		engineSteadyMb: { limit: 1024, measured: memory.engineSteadyMb, met: memory.engineSteadyMb <= 1024 },
		enginePeakMb: { limit: 1536, measured: memory.enginePeakMb, met: memory.enginePeakMb <= 1536 },
		finalConceptP95Ms: { limit: 300, measured: load["typed query to visible results ms"].p95, met: load["typed query to visible results ms"].p95 <= 300 },
		filterOnlyP95Ms: { limit: 50, measured: load["filter-only typed to visible results ms"].p95, met: load["filter-only typed to visible results ms"].p95 <= 50 },
		saveFreshnessP95Ms: { limit: 5000, measured: load["save to searchable ms"].p95, met: load["save to searchable ms"].p95 <= 5000 },
		uninterruptiblePassageMs: { limit: 100, ...load["background passage inference ms"], met: load["background passage inference ms"].slowest <= 100 },
		typedWhileIndexingP95Ms: { limit: 300, measured: load["typed query to visible results while indexing ms"].p95, met: load["typed query to visible results while indexing ms"].p95 <= 300 },
	},
	failures: load.failures,
};
await writeFile(outPath, `${JSON.stringify(manifest, null, 1)}\n`);
console.log(JSON.stringify(manifest.budgets, null, 1));
