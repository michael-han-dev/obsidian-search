// Usage: node scripts/live/load.ts <label> [notes] [root]
import { execFileSync } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Page } from "playwright-core";
import { E5_SMALL_V2 } from "../../src/core/encoder-spec.ts";
import { importModel } from "../../src/plugin/model-files.ts";
import { QUERIES } from "../../test/fixtures/vault.ts";
import { loadNotes } from "../load/notes.ts";
import { captureConsole, launch, liveRoot, openPane, pluginLoaded, prepare, type Session, statusOf, typeInPane, userGuard } from "./harness.ts";
import { createReport } from "./report.ts";

const label = process.argv[2] ?? "run";
const count = Number(process.argv[3] ?? 1000);
const live = liveRoot(resolve(process.argv[4] ?? "dev-assets/load"));
const out = join(live.root, "results");
const { step, expect, finish } = createReport();
const consoleErrors: string[] = [];
step("run", { label, notes: count, startedAt: new Date().toISOString() });

const quantile = (values: number[], q: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
};
const summary = (values: number[]) =>
	values.length === 0 ? null : { n: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95), max: Math.max(...values) };

async function bytesUnder(dir: string): Promise<number> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	let total = 0;
	for (const e of entries) total += e.isDirectory() ? await bytesUnder(join(dir, e.name)) : (await stat(join(dir, e.name))).size;
	return total;
}

function rendererRssMb(): number {
	const lines = execFileSync("ps", ["-axo", "rss=,command="], { encoding: "utf8" }).split("\n");
	const renderer = lines.filter((l) => l.includes(live.userData) && l.includes("--type=renderer"));
	return Math.round(renderer.reduce((n, l) => n + Number(l.trim().split(" ")[0]), 0) / 1024);
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

await mkdir(out, { recursive: true });
const guardBefore = await userGuard(live);
let session: Session | null = null;
try {
	await prepare(live, { fresh: true });
	const notes = loadNotes(count);
	for (const note of notes) {
		await mkdir(dirname(join(live.vault, note.path)), { recursive: true });
		await writeFile(join(live.vault, note.path), note.text);
	}
	step("vault", { notes: notes.length, bytes: await bytesUnder(live.vault) });
	const imported = await importModel(live.modelSource, live.dataDir, E5_SMALL_V2, () => {});
	if (!imported.ok) throw new Error(imported.message);

	session = await launch(live, 9342);
	const page = session.page;
	captureConsole(page, consoleErrors);
	await page.waitForFunction((n) => (window as any).app.vault.getMarkdownFiles().length === n, notes.length, { timeout: 60000 });
	await page.waitForTimeout(2000);
	step("load average at enable", loadavg().map((n) => Number(n.toFixed(2))));
	await page.evaluate(() => {
		const w = window as any;
		w.__load = { longTasks: 0, longTaskMs: 0, metadataChanged: 0 };
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) {
				w.__load.longTasks++;
				w.__load.longTaskMs += e.duration;
			}
		}).observe({ entryTypes: ["longtask"] });
		w.app.metadataCache.on("changed", () => w.__load.metadataChanged++);
	});
	const rssBefore = rendererRssMb();
	const enabledAt = Date.now();
	await page.getByRole("button", { name: "Trust author and enable plugins" }).click();
	await pluginLoaded(page);
	await openPane(page);
	await page.waitForFunction(() => (window as any).app.plugins.plugins.dowse.status?.model.kind === "loaded", null, { timeout: 60000 });
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
	let ready = false;
	let peakRss = rssBefore;
	while (!ready && Date.now() - enabledAt < 45 * 60_000) {
		await page.waitForTimeout(5000);
		const s = await statusOf(page);
		peakRss = Math.max(peakRss, rendererRssMb());
		progress.push({ s: Math.round((Date.now() - enabledAt) / 1000), text: s.text });
		ready = s.label === "ready";
		if (progress.length % 6 === 0) console.log("progress", progress.at(-1));
	}
	const indexedMs = Date.now() - enabledAt;
	if (!ready) throw new Error(`not ready after ${indexedMs} ms: ${JSON.stringify(progress.at(-1))}`);
	step("enable to ready ms", indexedMs);
	step("main thread while indexing", await page.evaluate(() => (window as any).__load));
	step("load average at ready", loadavg().map((n) => Number(n.toFixed(2))));
	step("progress", progress);
	await page.waitForTimeout(8000);
	step("index bytes", await bytesUnder(join(live.dataDir, "vaults")));
	step("renderer rss mb", { beforeEnable: rssBefore, peakWhileIndexing: peakRss, afterReady: rendererRssMb() });

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
	const targets = notes.filter((n) => n.path.startsWith("Garden/")).slice(0, 8);
	for (const [i, note] of targets.entries()) {
		const phrase = `zebra violin glacier ${i}`;
		const ms = await page.evaluate(
			async ({ path, phrase }) => {
				const app = (window as any).app;
				const file = app.vault.getAbstractFileByPath(path);
				const text = await app.vault.read(file);
				await app.vault.modify(file, `${text}\nA ${phrase} appeared in this note.\n`);
				const saved = performance.now();
				for (;;) {
					const r = await app.plugins.plugins.dowse.search(`"${phrase}" ${phrase}`, 10);
					const hit = r?.kind === "results" && r.files.some((f: any) => f.path === path && f.passages.some((p: any) => p.text.includes(phrase)));
					if (hit) return performance.now() - saved;
					if (performance.now() - saved > 60000) return -1;
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			},
			{ path: note.path, phrase },
		);
		freshness.push(ms);
	}
	step("save to searchable ms", { ...summary(freshness), raw: freshness.map((n) => Math.round(n)) });
	step("console errors", consoleErrors);
	expect("filter-only results visible within 50 ms at p95", summary(filterTyped)!.p95 <= 50, summary(filterTyped));
	expect("meaning results visible within 300 ms at p95", summary(typed)!.p95 <= 300 && summary(filteredMeaning)!.p95 <= 300, { typed: summary(typed), filtered: summary(filteredMeaning) });
	expect("a saved edit is searchable within 5 s at p95", freshness.every((ms) => ms >= 0) && summary(freshness)!.p95 <= 5000, freshness);
	expect("no console errors", consoleErrors.length === 0, consoleErrors);
} finally {
	await session?.close();
}
expect("your Obsidian untouched", JSON.stringify(guardBefore) === JSON.stringify(await userGuard(live)));
await finish(join(out, `${label}.json`));
