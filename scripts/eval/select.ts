// Applies the selection rule fixed in docs/m3-progress.md before any measurement.
// Usage: node scripts/eval/select.ts [evalDir]
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = process.argv[2] ?? "dev-assets/m3/eval";
const LICENSES = new Set(["mit", "apache-2.0"]);
const PASSAGE_LIMIT_MS = 100;
const ENGINE_STEADY_LIMIT_MB = 1024;
const DATASETS = ["SciFact", "NFCorpus", "FiQA2018"];

interface Row {
	readonly query: string;
	readonly kind: string;
	readonly rank: number;
	readonly passageHit: boolean | null;
	readonly topScore: number | null;
	readonly expectedScore: number | null;
}

function threshold(rows: readonly Row[]) {
	const truths = rows.filter((r) => r.kind !== "no-match" && r.rank === 1).map((r) => r.expectedScore!);
	const noMatch = rows.filter((r) => r.kind === "no-match").map((r) => r.topScore!);
	const floor = Math.min(...truths);
	const ceiling = Math.max(...noMatch);
	const value = Number(((floor + ceiling) / 2).toFixed(3));
	return { value, trueMatchFloor: Number(floor.toFixed(4)), noMatchCeiling: Number(ceiling.toFixed(4)), margin: Number((floor - ceiling).toFixed(4)), falsePositives: noMatch.filter((s) => s >= value).length, of: noMatch.length, hiddenTrueMatches: truths.filter((s) => s < value).length, ofTrue: truths.length };
}

const manifest: { name: string; license: string | string[]; files: Record<string, { bytes: number }>; onnx: string }[] = JSON.parse(await readFile("dev-assets/models/manifest.json", "utf8"));
const runtime: { name: string; modelMb: number; latency: Record<string, { medianMs: number }>; memory: Record<string, { rssMb: number }> }[] = JSON.parse(await readFile(join(dir, "runtime.json"), "utf8"));
const devsets: Record<string, Record<string, { rows: Row[] }>> = JSON.parse(await readFile(join(dir, "devsets.json"), "utf8"));
const beir: Record<string, Record<string, { ndcg10: number }>> = {};
for (const name of (await readdir(dir)).filter((f) => /^beir.*\.json$/.test(f))) {
	for (const [model, sets] of Object.entries(JSON.parse(await readFile(join(dir, name), "utf8")) as typeof beir)) beir[model] = { ...beir[model], ...sets };
}

const missed = (name: string): Set<string> =>
	new Set((devsets[name]?.["112"]?.rows ?? []).filter((r) => r.kind !== "no-match" && (r.rank !== 1 || r.passageHit === false)).map((r) => r.query));

const baseline = missed("e5-small-v2");
const rows = manifest.map((m) => {
	const run = runtime.find((r) => r.name === m.name)!;
	const license = String(m.license).toLowerCase().split(" ")[0]!;
	const scores = DATASETS.map((d) => beir[m.name]?.[d]?.ndcg10);
	const misses = devsets[m.name] ? missed(m.name) : null;
	const gates = {
		license: LICENSES.has(license),
		latency: run.latency["112"]!.medianMs <= PASSAGE_LIMIT_MS,
		memory: run.memory.loaded!.rssMb - run.memory.before!.rssMb <= ENGINE_STEADY_LIMIT_MB,
	};
	return {
		name: m.name,
		eligible: gates.license && gates.latency && gates.memory,
		gates,
		misses: misses ? [...misses] : null,
		lostVsE5: misses ? [...misses].filter((q) => !baseline.has(q)) : null,
		gainedVsE5: misses ? [...baseline].filter((q) => !misses.has(q)) : null,
		ndcg: Object.fromEntries(DATASETS.map((d, i) => [d, scores[i] ?? null])),
		meanNdcg: scores.every((s) => s !== undefined) ? Number((scores.reduce((a, b) => a + b!, 0)! / scores.length).toFixed(4)) : null,
		threshold: devsets[m.name] ? threshold(devsets[m.name]!["112"]!.rows) : null,
		downloadMb: Math.round((m.files[m.onnx]!.bytes + m.files["vocab.txt"]!.bytes) / 1e6),
		medianMsAt112: run.latency["112"]!.medianMs,
	};
});

const contenders = rows.filter((r) => r.eligible && r.misses !== null && r.lostVsE5!.length <= r.gainedVsE5!.length);
const fewest = Math.min(...contenders.map((r) => r.misses!.length));
const step1 = contenders.filter((r) => r.misses!.length === fewest);
const complete = step1.every((r) => r.meanNdcg !== null);
const best = Math.max(...step1.map((r) => r.meanNdcg ?? -1));
const step2 = step1.filter((r) => r.meanNdcg !== null && best - r.meanNdcg <= 0.01);
const step3 = [...step2].sort((a, b) => a.downloadMb - b.downloadMb || a.medianMsAt112 - b.medianMsAt112);
const decision = {
	step1: step1.map((r) => r.name),
	step2: complete ? step2.map((r) => ({ name: r.name, meanNdcg: r.meanNdcg })) : "waiting for public scores",
	selected: complete ? step3[0]!.name : null,
	tiedAfterStep3: complete ? step3.filter((r) => r.downloadMb === step3[0]!.downloadMb && Math.abs(r.medianMsAt112 - step3[0]!.medianMsAt112) <= 1).map((r) => r.name) : [],
};
await writeFile(join(dir, "selection.json"), `${JSON.stringify({ rows, decision }, null, 1)}\n`);
for (const r of rows) console.log(`${r.name.padEnd(24)} eligible=${r.eligible} misses=${r.misses?.length ?? "-"} lost=${r.lostVsE5?.length ?? "-"} gained=${r.gainedVsE5?.length ?? "-"} mean=${r.meanNdcg ?? "-"} ${JSON.stringify(r.ndcg)} threshold=${JSON.stringify(r.threshold)}`);
console.log(JSON.stringify(decision, null, 1));
