// Usage: node scripts/live/load.ts <label> [notes] [root]
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Page } from "playwright-core";
import { QUERIES } from "../../test/fixtures/vault.ts";
import { loadNotes } from "../load/notes.ts";
import { captureConsole, engineStatus, footprint, installModel, launch, liveRoot, openPane, pluginLoaded, prepare, type Session, statusOf, typeInPane, userGuard, waitForLabel } from "./harness.ts";
import { createReport } from "./report.ts";

const label = process.argv[2] ?? "run";
const count = Number(process.argv[3] ?? 1000);
const live = liveRoot(resolve(process.argv[4] ?? "dev-assets/load"));
const out = join(live.root, "results");
const { step, expect, finish } = createReport();
const consoleErrors: string[] = [];
const IDLE_MS = 60_000;
const ENGINE_STEADY_LIMIT_MB = 1024;
const ENGINE_PEAK_LIMIT_MB = 1536;
step("run", { label, notes: count, idleMs: IDLE_MS, startedAt: new Date().toISOString() });

const quantile = (values: number[], q: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
};
const summary = (values: number[]) =>
	values.length === 0 ? null : { n: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95), max: Math.max(...values) };
const PASSAGE_LIMIT_MS = 100;
const passageTimes = ({ passageMsHistogram: h, slowestPassageMs }: { passageMsHistogram: number[]; slowestPassageMs: number }) => {
	const n = h.reduce((a, b) => a + b, 0);
	const upTo = (q: number) => {
		let seen = 0;
		return 10 * (h.findIndex((count) => (seen += count) >= q * n) + 1);
	};
	return { n, p50AtMost: upTo(0.5), p99AtMost: upTo(0.99), atOrOver100: h.slice(PASSAGE_LIMIT_MS / 10).reduce((a, b) => a + b, 0), slowest: slowestPassageMs };
};

async function bytesUnder(dir: string): Promise<number> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	let total = 0;
	for (const e of entries) total += e.isDirectory() ? await bytesUnder(join(dir, e.name)) : (await stat(join(dir, e.name))).size;
	return total;
}

const request = (page: Page, text: string) =>
	page.evaluate(async (q) => {
		const started = performance.now();
		const response = await (window as any).app.plugins.plugins.dowse.search(q, 10);
		const ms = performance.now() - started;
		const files = response?.kind === "results" || response?.kind === "matching" ? response.files : [];
		const passages = files.reduce((n: number, f: any) => n + (f.passages?.length ?? (f.evidence ? 1 : 0)), 0);
		return { ms, kind: response?.kind, total: response?.total ?? files.length, files: files.length, passages, top: files[0]?.path ?? null };
	}, text);

const modelKind = (page: Page): Promise<string> => page.evaluate(() => (window as any).app.plugins.plugins.dowse.status?.model.kind ?? "none");

await mkdir(out, { recursive: true });
const guardBefore = await userGuard(live);
let session: Session | null = null;
try {
	await prepare(live, { fresh: true, plugin: false });
	const notes = loadNotes(count);
	for (const note of notes) {
		await mkdir(dirname(join(live.vault, note.path)), { recursive: true });
		await writeFile(join(live.vault, note.path), note.text);
	}
	step("vault", { notes: notes.length, bytes: await bytesUnder(live.vault) });

	session = await launch(live, 9342);
	await session.page.waitForFunction((n) => (window as any).app.vault.getMarkdownFiles().length === n, notes.length, { timeout: 60000 });
	await session.page.waitForTimeout(10000);
	const baseline = footprint(live);
	step("baseline footprint without Dowse, same vault", baseline);
	await session.close();
	session = null;

	await prepare(live, { fresh: false });
	await installModel(live);
	session = await launch(live, 9342, [], { env: { DOWSE_IDLE_MS: String(IDLE_MS) } });
	let page = session.page;
	captureConsole(page, consoleErrors);
	await page.waitForFunction((n) => (window as any).app.vault.getMarkdownFiles().length === n, notes.length, { timeout: 60000 });
	await page.waitForTimeout(2000);
	step("load average at enable", loadavg().map((n) => Number(n.toFixed(2))));
	await page.evaluate(() => {
		const w = window as any;
		w.__load = { longTasks: 0, longTaskMs: 0 };
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) {
				w.__load.longTasks++;
				w.__load.longTaskMs += e.duration;
			}
		}).observe({ entryTypes: ["longtask"] });
	});
	const beforeEnable = footprint(live);
	const enabledAt = Date.now();
	await page.getByRole("button", { name: "Trust author and enable plugins" }).click();
	await pluginLoaded(page);
	await openPane(page);
	await page.waitForFunction(() => (window as any).app.plugins.plugins.dowse.status?.model.kind === "loaded", null, { timeout: 60000, polling: 20 });
	step("enable to model loaded ms, cold", Date.now() - enabledAt);
	await page.waitForTimeout(3000);
	const newest = await page.evaluate(async () => {
		const worker: Worker = (window as any).app.plugins.plugins.dowse.client.worker;
		const answered: number[] = [];
		const started = performance.now();
		let lastMs = -1;
		const listen = (e: MessageEvent) => {
			if (e.data.type !== "response" || e.data.response.generation < 900001) return;
			answered.push(e.data.response.generation);
			if (e.data.response.generation === 900003) lastMs = performance.now() - started;
		};
		worker.addEventListener("message", listen);
		for (const [generation, relevance] of [[900001, "first"], [900002, "second"], [900003, "how often should I feed the bread culture"]] as const) {
			worker.postMessage({ type: "search", request: { generation, query: { constraints: [], relevance }, limit: 10 } });
		}
		await new Promise((resolve) => setTimeout(resolve, 3000));
		worker.removeEventListener("message", listen);
		const status = (window as any).app.plugins.plugins.dowse.status;
		return { answered, lastMs, coverage: status.coverage };
	});
	step("three searches sent at once during indexing", newest);
	expect("during indexing only the newest pending search is answered, within 300 ms", JSON.stringify(newest.answered) === "[900003]" && newest.lastMs >= 0 && newest.lastMs < 300 && newest.coverage.embeddedSources < newest.coverage.totalSources, newest);
	const progress: { s: number; text: string }[] = [];
	const duringIndexing: number[] = [];
	let ready = false;
	let peakFootprint = beforeEnable.footprintMb;
	for (let i = 0; !ready && Date.now() - enabledAt < 45 * 60_000; i++) {
		const query = QUERIES[i % QUERIES.length]!.text;
		const typed = await typeInPane(page, query, { delay: 30 });
		if ((await statusOf(page)).label === "indexing") duringIndexing.push(typed.latencyMs);
		await page.waitForTimeout(2000);
		const s = await statusOf(page);
		peakFootprint = Math.max(peakFootprint, footprint(live).footprintMb);
		progress.push({ s: Math.round((Date.now() - enabledAt) / 1000), text: s.text });
		ready = s.label === "ready";
		if (progress.length % 12 === 0) console.log("progress", progress.at(-1));
	}
	const indexedMs = Date.now() - enabledAt;
	if (!ready) throw new Error(`not ready after ${indexedMs} ms: ${JSON.stringify(progress.at(-1))}`);
	step("enable to ready ms", indexedMs);
	step("typed query to visible results while indexing ms", summary(duringIndexing));
	step("main thread while indexing", await page.evaluate(() => (window as any).__load));
	step("load average at ready", loadavg().map((n) => Number(n.toFixed(2))));
	step("progress", progress);
	await page.waitForTimeout(8000);
	step("index bytes", await bytesUnder(join(live.dataDir, "vaults")));
	step("model bytes", await bytesUnder(join(live.dataDir, "models")));
	const steady = footprint(live);
	const indexedCounters = (await engineStatus(page)).counters;
	step("counters after indexing", indexedCounters);
	step("background passage inference ms", passageTimes(indexedCounters));

	const fixtureRanks: string[] = [];
	const typed: number[] = [];
	const embed: number[] = [];
	for (let round = 0; round < 3; round++) {
		for (const q of QUERIES) {
			const r = await typeInPane(page, q.text, { delay: 30, waitMs: 100 });
			typed.push(r.latencyMs);
			embed.push(r.embedMs);
			if (round === 0) fixtureRanks.push(`${r.rows.indexOf(q.expectedSource) + 1}:${q.text}`);
		}
	}
	step("typed query to visible results ms", summary(typed));
	step("query embedding ms", summary(embed));
	step("fixture ranks under load", fixtureRanks);

	const FILTERS = ["tag:cooking", "tag:work/meetings", "path:Garden", 'property.status:"in progress"', '"toast the"', "-draft tag:travel", "file:winter", "property.priority:3 tag:finance"];
	const filterTyped: number[] = [];
	const filterRequests: number[] = [];
	const filterCounts: Record<string, number> = {};
	for (let round = 0; round < 5; round++) {
		for (const f of FILTERS) {
			const r = await typeInPane(page, f, { delay: 30, waitMs: 100 });
			if (r.kind !== "matching") throw new Error(`${f} answered ${r.kind}`);
			filterTyped.push(r.latencyMs);
			const req = await request(page, f);
			filterRequests.push(req.ms);
			filterCounts[f] = req.total;
		}
	}
	step("filter-only typed to visible results ms", summary(filterTyped));
	step("filter-only request ms", summary(filterRequests));
	step("filter-only matching notes", filterCounts);
	if (Object.values(filterCounts).some((n) => n === 0)) throw new Error(`a filter matched nothing: ${JSON.stringify(filterCounts)}`);
	const filteredMeaning: number[] = [];
	for (const q of ["tag:health trouble sleeping", "path:Kitchen something to cook with chickpeas", 'property.status:done -tag:work where to stay']) filteredMeaning.push((await typeInPane(page, q, { delay: 30, waitMs: 100 })).latencyMs);
	step("filtered meaning typed to visible results ms", summary(filteredMeaning));

	const requests: number[] = [];
	for (let round = 0; round < 3; round++) for (const q of QUERIES) requests.push((await request(page, q.text)).ms);
	step("request to ten results with passages ms", summary(requests));
	step("sample request", await request(page, QUERIES[0]!.text));

	const freshness: number[] = [];
	const probeShown: boolean[] = [];
	const targets = notes.filter((n) => n.path.startsWith("Garden/")).slice(0, 8);
	for (const [i, note] of targets.entries()) {
		const phrase = `frostlog${i}`;
		const { ms, shown } = await page.evaluate(
			async ({ path, phrase }) => {
				const app = (window as any).app;
				const file = app.vault.getAbstractFileByPath(path);
				const text = await app.vault.read(file);
				await app.vault.modify(file, `${text}\nA late frost damaged the seedlings, ${phrase}.\n`);
				const saved = performance.now();
				// Only the new revision holds the phrase, so the note can rank here only once that revision is embedded.
				for (;;) {
					const r = await app.plugins.plugins.dowse.search(`"${phrase}" frost damaged the seedlings`, 10);
					const file = r?.kind === "results" ? r.files.find((f: any) => f.path === path) : undefined;
					if (file) return { ms: performance.now() - saved, shown: file.passages.some((p: any) => p.text.includes(phrase)) };
					if (performance.now() - saved > 60000) return { ms: -1, shown: false };
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			},
			{ path: note.path, phrase },
		);
		freshness.push(ms);
		probeShown.push(shown);
	}
	step("save to searchable ms", { ...summary(freshness), raw: freshness.map((n) => Math.round(n)) });
	step("edited passage among the three shown", `${probeShown.filter(Boolean).length} of ${probeShown.length}`);

	const postIdle: number[] = [];
	let released = steady;
	for (let round = 0; round < 3; round++) {
		await page.waitForFunction(() => (window as any).app.plugins.plugins.dowse.status.model.kind === "released", null, { timeout: IDLE_MS + 30000, polling: 200 });
		await page.waitForTimeout(1000);
		released = footprint(live);
		const q = QUERIES[round]!;
		const r = await typeInPane(page, q.text, { delay: 30, settled: (p) => p.rows[0] === q.expectedSource, timeout: 20000 });
		postIdle.push(r.latencyMs);
	}
	step("typed query after idle release to visible results ms", { ...summary(postIdle), raw: postIdle.map((n) => Math.round(n)) });
	step("counters after idle cycles", (await engineStatus(page)).counters);
	await page.waitForTimeout(3000);
	const lifetime = footprint(live);
	await session.close();
	session = null;

	session = await launch(live, 9342, [], { env: { DOWSE_IDLE_MS: String(IDLE_MS) } });
	page = session.page;
	captureConsole(page, consoleErrors);
	const relaunchedAt = Date.now();
	await pluginLoaded(page);
	await openPane(page);
	let loadedAt = 0;
	while ((await modelKind(page)) !== "loaded" && Date.now() - relaunchedAt < 60000) await page.waitForTimeout(20);
	loadedAt = Date.now() - relaunchedAt;
	await waitForLabel(page, ["ready"], 120000);
	const restartReady = Date.now() - relaunchedAt;
	const restartStatus = await engineStatus(page);
	step("restart", { pluginLoadedToModelLoadedMs: loadedAt, pluginLoadedToReadyMs: restartReady, passageInferences: restartStatus.passageInferences });

	const memory = {
		baseline,
		beforeEnable,
		peakSampled: peakFootprint,
		lifetimePeak: lifetime.peakMb,
		steadyLoaded: steady.footprintMb,
		afterIdleRelease: released.footprintMb,
		engineSteadyMb: steady.footprintMb - baseline.footprintMb,
		enginePeakMb: Math.max(lifetime.peakMb, peakFootprint) - baseline.footprintMb,
		engineAfterReleaseMb: released.footprintMb - baseline.footprintMb,
	};
	step("renderer physical footprint mb", memory);
	step("console errors", consoleErrors);
	expect("filter-only results visible within 50 ms at p95", summary(filterTyped)!.p95 <= 50, summary(filterTyped));
	expect("meaning results visible within 300 ms at p95", summary(typed)!.p95 <= 300 && summary(filteredMeaning)!.p95 <= 300, { typed: summary(typed), filtered: summary(filteredMeaning) });
	expect("meaning results visible within 300 ms at p95 while bulk indexing runs", duringIndexing.length >= 10 && summary(duringIndexing)!.p95 <= 300, summary(duringIndexing));
	expect("a saved edit is searchable within 5 s at p95", freshness.every((ms) => ms >= 0) && summary(freshness)!.p95 <= 5000, freshness);
	expect(`engine memory within ${ENGINE_STEADY_LIMIT_MB} MB steady and ${ENGINE_PEAK_LIMIT_MB} MB peak`, memory.engineSteadyMb <= ENGINE_STEADY_LIMIT_MB && memory.enginePeakMb <= ENGINE_PEAK_LIMIT_MB, memory);
	expect(`every background passage inference within ${PASSAGE_LIMIT_MS} ms`, indexedCounters.slowestPassageMs <= PASSAGE_LIMIT_MS, passageTimes(indexedCounters));
	expect("a restart restores the index without embedding", restartStatus.passageInferences === 0, restartStatus.counters);
	expect("no console errors", consoleErrors.length === 0, consoleErrors);
} finally {
	await session?.close();
}
expect("your Obsidian untouched", JSON.stringify(guardBefore) === JSON.stringify(await userGuard(live)));
await finish(join(out, `${label}.json`));
