import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { CDPSession, Page } from "playwright-core";
import { ENCODER } from "../../src/core/encoder-spec.ts";
import { digest } from "../../src/core/hash.ts";
import { KNOWN_MISSES, PARAPHRASE_NOTES, PARAPHRASE_SEARCHES } from "../../test/fixtures/paraphrase.ts";
import {
	captureConsole,
	closeModal,
	engineStatus,
	focusMain,
	footprint,
	importInSetup,
	launch,
	liveRoot,
	OFFLINE_ARGS,
	openPane,
	openSetup,
	pluginLoaded,
	prepare,
	search,
	type Session,
	setupState,
	statusOf,
	typeInPane,
	userGuard,
	waitForLabel,
	waitForSetup,
	writeNotes,
} from "./harness.ts";
import { startModelServer } from "./model-server.ts";
import { createReport, walk } from "./report.ts";

const live = liveRoot(resolve(process.argv[2] ?? "dev-assets/live-m3"));
const out = join(live.root, "results");
const { step, expect, finish } = createReport();
const consoleErrors: string[] = [];
const PORT = 9346;
const MB = 1e6;
const modelsDir = join(live.dataDir, "models");
const partialModel = join(modelsDir, `${ENCODER.folderName}.partial`, ENCODER.model.name);
const lockFile = join(modelsDir, `${ENCODER.folderName}.lock`);
const installedModel = join(modelsDir, ENCODER.folderName, ENCODER.model.name);
const sizeOf = async (path: string) => (await stat(path).catch(() => null))?.size ?? -1;
const megabytes = (text: string) => Number(/Getting the model: (\d+) of/.exec(text)?.[1] ?? -1);
const totalMb = Math.round((ENCODER.model.bytes + ENCODER.vocab.bytes) / MB);

const server = await startModelServer(ENCODER, live.modelSource);
const env = { DOWSE_MODEL_BASE_URL: server.baseUrl };
const modelRequests = () => server.requests.filter((r) => r.path.endsWith(ENCODER.model.path));
const click = (page: Page, text: string) => page.locator(".dowse-setup button", { hasText: text }).first().click();

async function start(extra: { args?: string[]; env?: Record<string, string>; trust?: boolean } = {}): Promise<Session> {
	const session = await launch(live, PORT, extra.args ?? [], { env: { ...env, ...extra.env } });
	captureConsole(session.page, consoleErrors);
	if (extra.trust) await session.page.getByRole("button", { name: "Trust author and enable plugins" }).click();
	await pluginLoaded(session.page);
	await openPane(session.page);
	return session;
}

async function screencast(page: Page): Promise<() => Promise<string>> {
	const frames: { file: string; at: number }[] = [];
	const dir = join(out, "frames");
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	const cdp: CDPSession = await page.context().newCDPSession(page);
	cdp.on("Page.screencastFrame", (frame) => {
		const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
		frames.push({ file, at: frame.metadata.timestamp ?? Date.now() / 1000 });
		void writeFile(file, Buffer.from(frame.data, "base64"));
		void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
	});
	await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
	return async () => {
		await cdp.send("Page.stopScreencast").catch(() => {});
		await new Promise((r) => setTimeout(r, 500));
		const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.04, (frames[i + 1]?.at ?? f.at + 1) - f.at).toFixed(3)}`).join("\n");
		await writeFile(join(dir, "list.txt"), `${list}\nfile '${frames.at(-1)!.file}'\n`);
		const video = join(out, "setup-recording.mp4");
		execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-pix_fmt", "yuv420p", video]);
		return `${frames.length} frames over ${(frames.at(-1)!.at - frames[0]!.at).toFixed(1)} s`;
	};
}

const lineOf = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

await mkdir(out, { recursive: true });
const guardBefore = await userGuard(live);
let session: Session | null = null;
try {
	await prepare(live, { fresh: true });
	await writeNotes(live.vault, PARAPHRASE_NOTES);

	session = await start({ trust: true });
	let page = session.page;
	await waitForLabel(page, ["model-needed"]);
	expect("a fresh install asks for a one-time setup and offers it", (await statusOf(page)).text === "Concept search needs a one-time model setup. Filters already work." && (await page.locator(".dowse-action").textContent()) === "Set up concept search", await statusOf(page));
	expect("filter-only lists work before setup", JSON.stringify((await typeInPane(page, "path:Daily", { waitMs: 100 })).rows) === JSON.stringify(["Daily/2026-09-02.md", "Daily/2026-09-19.md"]));
	expect("a search with words answers not-ready before setup", (await search(page, "why does my vehicle screech when stopping")).kind === "not-ready");

	await openSetup(page);
	await page.screenshot({ path: join(out, "setup-01-model-needed.png") });
	const facts = await page.evaluate(() => document.querySelector(".dowse-facts")?.textContent ?? "");
	step("setup facts", facts);
	expect(
		"the setup screen shows model, license, actual size, storage, and network use",
		facts.includes(ENCODER.id) && facts.includes(`${ENCODER.license} license`) && facts.includes(`${totalMb} MB from huggingface.co`) && facts.includes(live.dataDir) && facts.includes("Only this download"),
		facts,
	);

	server.mode = { kind: "refuse", status: 503 };
	await click(page, "Download and set up");
	const refused = await waitForSetup(page, (s) => s.label === "failed");
	expect("a refused download shows an actionable failure", refused.text.startsWith("Downloading model.onnx failed with HTTP 503."), refused);
	expect("filter-only lists work while setup has failed", (await search(page, "path:Daily")).kind === "matching" && (await statusOf(page)).label === "failed");

	server.mode = { kind: "normal", bytesPerSecond: 10 * MB };
	await click(page, "Retry");
	const going = await waitForSetup(page, (s) => s.label === "acquiring" && megabytes(s.text) >= 15);
	await page.screenshot({ path: join(out, "setup-02-progress.png") });
	const paneWhileGetting = await page.evaluate(() => document.querySelector(".dowse-status")?.textContent ?? "");
	expect("progress shows in the setup screen and the pane", /Getting the model: \d+ of \d+ MB\./.test(going.text) && /^Getting the model… \d+ of \d+ MB\.$/.test(paneWhileGetting), { going, paneWhileGetting });
	expect("filter-only lists work during acquisition", (await search(page, "path:Daily")).kind === "matching");
	await click(page, "Cancel");
	await waitForSetup(page, (s) => s.label === "model-needed");
	await page.waitForTimeout(300);
	expect("cancel discards the partial download and the lock", (await sizeOf(partialModel)) === -1 && (await sizeOf(lockFile)) === -1 && modelRequests().at(-1)!.closedEarly, { partial: await sizeOf(partialModel), lock: await sizeOf(lockFile) });

	server.mode = { kind: "cut", afterBytes: 30 * MB };
	await click(page, "Download and set up");
	const cut = await waitForSetup(page, (s) => s.label === "failed");
	const cutSize = await sizeOf(partialModel);
	expect("a dropped connection fails with a retry that resumes", cut.text.startsWith("The transfer of model.onnx stopped:") && cut.text.endsWith("Retry continues where it stopped.") && cutSize >= 10 * MB, { cut, cutSize });

	server.mode = { kind: "corrupt" };
	await click(page, "Retry");
	const corrupt = await waitForSetup(page, (s) => s.label === "failed" && s.text.includes("checksum"));
	expect(
		"a corrupted download fails its checksum, resumed from the partial file, and installs nothing",
		corrupt.text.startsWith("model.onnx does not match the published SHA-256 checksum") && modelRequests().at(-1)!.range === `bytes=${cutSize}-` && (await sizeOf(partialModel)) === -1 && (await sizeOf(installedModel)) === -1,
		{ corrupt, range: modelRequests().at(-1)!.range },
	);

	server.mode = { kind: "normal", bytesPerSecond: 10 * MB };
	await click(page, "Retry");
	await waitForSetup(page, (s) => s.label === "acquiring" && megabytes(s.text) >= 40);
	await session.close();
	session = null;
	const quitSize = await sizeOf(partialModel);
	expect("quitting mid-download leaves the partial file and a stale lock", quitSize >= 40 * MB && (await sizeOf(lockFile)) > 0, { quitSize, lock: await sizeOf(lockFile) });

	session = await start();
	page = session.page;
	await waitForLabel(page, ["model-needed"]);
	await openSetup(page);
	const stopRecording = await screencast(page);
	await page.waitForTimeout(800);
	server.mode = { kind: "normal", bytesPerSecond: 40 * MB };
	const requestsBefore = modelRequests().length;
	const setupStarted = Date.now();
	await click(page, "Download and set up");
	for (let i = 0; i < 200 && modelRequests().length === requestsBefore; i++) await page.waitForTimeout(25);
	const resumedFrom = modelRequests()[requestsBefore]?.range;
	const loading = await waitForSetup(page, (s) => s.label !== "acquiring", 120000);
	const searchable = await waitForSetup(page, (s) => s.label === "indexing" || s.label === "ready", 120000);
	step("setup after restart", { resumedFrom, quitSize, firstAfterAcquire: loading.label, searchableMs: Date.now() - setupStarted, state: searchable });
	expect("after a restart the download resumes from the partial file", resumedFrom === `bytes=${quitSize}-`, { resumedFrom, quitSize });
	const early = await search(page, "why does my vehicle screech when stopping");
	step("search while indexing", { kind: early.kind, coverage: early.coverage });
	expect("a search while indexing answers from the embedded notes and reports partial coverage", early.kind === "results" && !!early.coverage && early.coverage.embeddedSources < early.coverage.totalSources, early.coverage);
	await page.waitForTimeout(600);
	await closeModal(page);
	await focusMain(page);
	const firstPane = await typeInPane(page, "deadline to cancel the supplier agreement before it rolls over", { delay: 60, waitMs: 1200 });
	await waitForLabel(page, ["ready"], 120000);
	await page.waitForTimeout(500);
	const recording = await stopRecording();
	step("recording", recording);
	expect("the first concept search after setup ranks the right note", firstPane.rows[0] === "Daily/2026-09-02.md", firstPane);
	const dataAfterSetup = (await walk(live.dataDir)).map((f) => relative(live.dataDir, f)).filter((f) => f.startsWith("models/")).sort();
	expect("setup leaves exactly the verified model files", JSON.stringify(dataAfterSetup) === JSON.stringify([`models/${ENCODER.folderName}/${ENCODER.model.name}`, `models/${ENCODER.folderName}/${ENCODER.vocab.name}`].sort()), dataAfterSetup);

	const judgments: { query: string; kind: string; expected: string | null; rank: number; top: string | null; passage: string | null; heading: string; score: number | null; summary: string }[] = [];
	const failures: string[] = [];
	const missed: string[] = [];
	for (const c of PARAPHRASE_SEARCHES) {
		const pane = await typeInPane(page, c.query, { waitMs: 150 });
		const shown = await page.evaluate(() => ({
			passage: document.querySelector(".dowse-result .dowse-passage")?.textContent ?? null,
			heading: document.querySelector(".dowse-result .dowse-heading")?.textContent ?? "",
		}));
		const found = await search(page, c.query, 5);
		const expected = c.kind === "no-match" ? null : c.top;
		judgments.push({ query: c.query, kind: c.kind, expected, rank: expected ? pane.rows.indexOf(expected) + 1 : 0, top: pane.rows[0] ?? null, passage: shown.passage, heading: shown.heading, score: found.files[0]?.passages[0]?.score ?? null, summary: pane.summary });
		const ok =
			c.kind === "no-match"
				? pane.kind === "results" && pane.rows.length === 0 && pane.summary === "No strong matches."
				: pane.rows[0] === c.top && !!shown.passage?.includes(c.passage) && (c.kind !== "literal" || !pane.rows.includes(c.absent));
		if (!ok) missed.push(c.query);
		if (ok === KNOWN_MISSES.includes(c.query)) failures.push(`${c.query}: ${JSON.stringify({ top: pane.rows.slice(0, 3), passage: shown.passage?.slice(0, 60), summary: pane.summary })}`);
		if (c.query.startsWith("why does my vehicle")) await page.screenshot({ path: join(out, "paraphrase-vehicle.png") });
	}
	await writeFile(join(out, "paraphrase-judgments.json"), `${JSON.stringify(judgments, null, 1)}\n`);
	expect(`the development paraphrase searches find the supporting passage (${PARAPHRASE_SEARCHES.length - missed.length} of ${PARAPHRASE_SEARCHES.length}), and the only miss is the recorded one`, failures.length === 0, failures);

	await typeInPane(page, "which medicine she takes in the morning", { waitMs: 150 });
	await page.locator(".dowse-input").press("Enter");
	await page.waitForTimeout(800);
	const opened = await page.evaluate(() => {
		const app = (window as any).app;
		return { path: app.workspace.getActiveFile()?.path, line: app.workspace.activeEditor?.editor?.getCursor().line + 1 };
	});
	const mum = PARAPHRASE_NOTES["Family/Notes for Mum.md"]!;
	expect("Enter opens the note at the supporting passage", opened.path === "Family/Notes for Mum.md" && opened.line === lineOf(mum, "The blue one with breakfast"), opened);
	await openPane(page);

	const before = (await engineStatus(page)).counters.queryInferences;
	await search(page, "path:Daily");
	await search(page, '"brake pads"');
	const afterFilters = (await engineStatus(page)).counters.queryInferences;
	const grouped = await search(page, "what could make our infrastructure costs blow up", 20);
	await page.waitForTimeout(100);
	const afterRanked = (await engineStatus(page)).counters.queryInferences;
	const ids = grouped.files.flatMap((f) => f.passages.map((p) => ({ path: f.path, id: (p as unknown as { passageId: string }).passageId })));
	step("query inferences", { before, afterFilters, afterRanked, passages: ids.length });
	expect("constraint-only searches run no inference, and a search with words runs exactly one", afterFilters === before && afterRanked === before + 1, { before, afterFilters, afterRanked });
	expect("every grouped passage keeps its own passage ID from its note", ids.length > grouped.files.length && new Set(ids.map((p) => p.id)).size === ids.length && ids.every((p) => p.id.startsWith(`${p.path}#`)), ids.slice(0, 4));

	const settle = async (want: number) => {
		await page.waitForFunction((n) => {
			const s = (window as any).app.plugins.plugins.dowse.status;
			return s.coverage.totalSources === n && s.coverage.embeddedSources === n;
		}, want, { timeout: 120000, polling: 50 });
		return (await engineStatus(page)).passageInferences;
	};
	const create = (path: string, text: string) => page.evaluate(({ path, text }) => (window as any).app.vault.create(path, text).then(() => null), { path, text });
	const modify = (path: string, text: string) => page.evaluate(({ path, text }) => { const app = (window as any).app; return app.vault.modify(app.vault.getAbstractFileByPath(path), text).then(() => null); }, { path, text });
	let notes = Object.keys(PARAPHRASE_NOTES).length;
	let inferences = await settle(notes);
	const delta = async (want: number, action: () => Promise<unknown>) => {
		await action();
		await page.waitForTimeout(600);
		const now = await settle(want);
		const d = now - inferences;
		inferences = now;
		return d;
	};
	const body = "Book the large meeting room through the front desk. Bring the projector remote back afterwards.\n";
	await page.evaluate(() => (window as any).app.vault.createFolder("Identity").then(() => null, () => null));
	const twoTitles = await delta((notes += 2), async () => {
		await create("Identity/Alpha.md", body);
		await create("Identity/Beta.md", body);
	});
	await page.evaluate(async () => {
		await (window as any).app.vault.createFolder("Identity/One").catch(() => null);
		await (window as any).app.vault.createFolder("Identity/Two").catch(() => null);
		return null;
	});
	const sameInput = await delta((notes += 2), async () => {
		await create("Identity/One/Setup.md", body);
		await create("Identity/Two/Setup.md", body);
	});
	const sections = "# Sections\n\n## Morning\n\nWater the plants and open the windows.\n\n## Noon\n\nEat lunch away from the desk.\n\n## Evening\n\nWrite tomorrow's list before bed.\n";
	await delta((notes += 1), () => create("Identity/Sections.md", sections));
	const headingOnly = await delta(notes, () => modify("Identity/Sections.md", sections.replace("## Noon", "## Midday")));
	const titleOnly = await delta(notes, () => page.evaluate(() => { const app = (window as any).app; return app.fileManager.renameFile(app.vault.getAbstractFileByPath("Identity/Alpha.md"), "Identity/Gamma.md").then(() => null); }));
	step("inferences per identity case", { twoTitles, sameInput, headingOnly, titleOnly });
	expect("identical bodies under different titles embed separately", twoTitles === 2, twoTitles);
	expect("identical full inputs in separate notes embed once", sameInput === 1, sameInput);
	expect("a heading-only edit re-embeds only that section", headingOnly === 1, headingOnly);
	expect("a title-only change re-embeds the note, because the title is in the input", titleOnly === 1, titleOnly);

	const words = (seed: string) => Array.from({ length: 160 }, (_, i) => `${seed}${i % 7 === 0 ? "," : ""}`).join(" ");
	const longLine = `Opening principles for chess beginners start with controlling the centre. ${words("filler")} The middle of this line explains why knights belong on central squares before the bishops move. ${words("padding")} At the very end we compare the Sicilian Defence with the French Defence for players who like sharp positions.`;
	const longInfer = await delta((notes += 1), () => create("Long line.md", `${longLine}\n`));
	const coverage: { probe: string; top: string | undefined; column: number; matchesSource: boolean }[] = [];
	for (const [probe, phrase] of [
		["how should a beginner start a chess game", "centre"],
		["where should knights go early in the game", "knights"],
		["compare the Sicilian and French defences", "Sicilian"],
	] as const) {
		const r = await search(page, probe, 3);
		const top = r.files[0];
		const passage = top?.passages.find((p) => p.text.includes(phrase));
		coverage.push({ probe, top: top?.path, column: passage?.span.start.column ?? -1, matchesSource: !!passage && longLine.slice(passage.span.start.column, passage.span.end.column) === passage.text });
	}
	step("long line", { characters: longLine.length, passagesEmbedded: longInfer, coverage });
	expect("a 2,000-character line is split into many passages, and its start, middle, and end are each searchable at their own columns", longInfer >= 4 && coverage.every((c) => c.top === "Long line.md" && c.matchesSource) && coverage[1]!.column > 0 && coverage[2]!.column > coverage[1]!.column, coverage);

	const carPath = "Daily/2026-09-19.md";
	const carOld = PARAPHRASE_NOTES[carPath]!;
	const carNew = carOld.replace("The garage said the squeal is the brake pads worn down to the metal. Replacement booked for Friday, about 180 including labour.", "The windscreen wiper was replaced at the petrol station.");
	const oldRevision = await digest(carOld);
	const newRevision = await digest(carNew);
	const carQuery = "why does my vehicle screech when stopping";
	expect("before the edit, the note ranks with its current revision", (await search(page, carQuery, 20)).files.find((f) => f.path === carPath)?.revision === oldRevision);
	await modify(carPath, carNew);
	for (let i = 0; i < 500 && (await search(page, `path:"${carPath}"`, 5)).files[0]?.revision !== newRevision; i++) await page.waitForTimeout(20);
	const landed: (string | null)[] = [];
	for (const until = Date.now() + 3000; Date.now() < until; ) {
		const hit = (await search(page, carQuery, 20)).files.find((f) => f.path === carPath);
		landed.push(hit ? (hit.revision === oldRevision ? "old" : hit.revision === newRevision ? "new" : "other") : null);
		await page.waitForTimeout(30);
	}
	await settle(notes);
	const wiper = (await search(page, "who replaced the windscreen wiper", 5)).files[0];
	step("ranked searches after the edit landed", { responses: landed.length, old: landed.filter((x) => x === "old").length, new: landed.filter((x) => x === "new").length, absent: landed.filter((x) => x === null).length });
	expect("once an edit lands, no ranked search returns the retired revision, and the new one becomes searchable", landed.length > 10 && !landed.includes("old") && wiper?.path === carPath && wiper.revision === newRevision, { landed: landed.slice(0, 10), wiper: wiper?.path });
	await page.evaluate(() => { const app = (window as any).app; return app.vault.delete(app.vault.getAbstractFileByPath("Inbox/Clipping 2.md")).then(() => null); });
	notes -= 1;
	await settle(notes);
	const afterDelete = await search(page, "best way to memorise things for a test", 20);
	expect("after a delete lands, the note never returns", !afterDelete.files.some((f) => f.path === "Inbox/Clipping 2.md"), afterDelete.files.map((f) => f.path));
	await page.waitForTimeout(3000);
	await session.close();
	session = null;

	const offlineEdit = "Projects/Beacon/Notes.md";
	const beaconOld = PARAPHRASE_NOTES[offlineEdit]!;
	const beaconNew = "# Beacon\n\n## Background\n\nBeacon was retired in favour of off-the-shelf shelf sensors.\n";
	await writeFile(join(live.vault, offlineEdit), beaconNew);
	session = await start();
	page = session.page;
	const startup: (string | null)[] = [];
	for (let i = 0; i < 200; i++) {
		const r = await search(page, '"Beacon" what could go badly wrong', 5);
		const hit = r.files.find((f) => f.path === offlineEdit);
		startup.push(r.kind === "results" ? (hit ? (hit.revision === (await digest(beaconOld)) ? "old" : "new") : "absent") : r.kind);
		if ((await statusOf(page)).label === "ready" && i > 5) break;
		await page.waitForTimeout(20);
	}
	await waitForLabel(page, ["ready"]);
	const retired = (await search(page, "why was the shelf sensor firmware dropped", 5)).files[0];
	step("searches during a restart after an edit made while closed", startup);
	expect("an edit made while Obsidian was closed never lets the saved index return the old revision", !startup.includes("old") && retired?.path === offlineEdit && retired.revision === (await digest(beaconNew)), { startup: startup.slice(0, 8), retired: retired?.path });
	await page.waitForTimeout(3000);
	await session.close();
	session = null;

	session = await start({ env: { DOWSE_IDLE_MS: "4000" } });
	page = session.page;
	const whileLoading: { label: string; kind: string }[] = [];
	for (let i = 0; i < 300 && !whileLoading.some((x) => x.kind === "matching" && x.label === "loading"); i++) {
		const label = (await statusOf(page)).label;
		const r = await search(page, "path:Daily");
		if (r.kind !== "null") whileLoading.push({ label: (await statusOf(page)).label === label ? label : "changed", kind: r.kind });
		if (label === "ready") break;
	}
	step("filter-only searches during startup", whileLoading.slice(0, 6));
	expect(
		"a restart shows loading, never the setup prompt, and filter-only lists answer while the model loads",
		whileLoading.some((x) => x.kind === "matching" && x.label === "loading") && !whileLoading.some((x) => x.label === "model-needed"),
		whileLoading.slice(0, 6),
	);
	await waitForLabel(page, ["ready"]);
	const restored = await engineStatus(page);
	const loadedMemory = footprint(live);
	await page.waitForFunction(() => (window as any).app.plugins.plugins.dowse.status.model.kind === "released", null, { timeout: 30000, polling: 100 });
	await page.waitForTimeout(1500);
	const releasedMemory = footprint(live);
	const released = await engineStatus(page);
	await page.evaluate(() => {
		const el = document.querySelector(".dowse-status") as HTMLElement;
		(window as any).__labels = [];
		new MutationObserver(() => (window as any).__labels.push(el.dataset.label)).observe(el, { attributes: true, attributeFilter: ["data-label"] });
	});
	const postIdle = await typeInPane(page, "trouble staying asleep through the night", { settled: (p) => p.rows.length > 0, timeout: 20000 });
	const labels: string[] = await page.evaluate(() => (window as any).__labels);
	const reloaded = await engineStatus(page);
	step("idle release", { restoredInferences: restored.passageInferences, loadedMemory, releasedMemory, released: released.counters, postIdleMs: postIdle.latencyMs, labels, reloaded: reloaded.counters });
	expect("an idle model is released: no live session, and the renderer's footprint drops", released.model.kind === "released" && released.counters.sessionsLive === 0 && releasedMemory.footprintMb < loadedMemory.footprintMb - 150, { loadedMemory, releasedMemory });
	expect("the first search after release shows loading, reloads one session, and answers with one query inference", labels.includes("loading") && postIdle.rows[0] === "Journal/Week 37.md" && reloaded.counters.sessionsCreated === released.counters.sessionsCreated + 1 && reloaded.counters.sessionsLive === 1 && reloaded.counters.queryInferences === released.counters.queryInferences + 1, { labels, rows: postIdle.rows.slice(0, 2) });

	await page.waitForFunction(() => (window as any).app.plugins.plugins.dowse.status.model.kind === "released", null, { timeout: 30000, polling: 100 });
	const model = await readFile(installedModel);
	model.writeUInt8(model.readUInt8(model.length >> 1) ^ 0xff, model.length >> 1);
	await writeFile(installedModel, model);
	const journalPath = "Journal/Week 37.md";
	const journalNew = "# Week 37\n\nSlept through every night this week after the move.\n";
	await modify(journalPath, journalNew);
	await waitForLabel(page, ["failed"], 30000);
	const failedStatus = await statusOf(page);
	const during = await search(page, "waking at 3am thinking about work", 20);
	const filtered = await search(page, "path:Journal");
	step("failed update", { status: failedStatus, during: { kind: during.kind, coverage: during.coverage } });
	expect(
		"a damaged model file fails with a retry, and the edited note's old revision is not searchable",
		failedStatus.text.includes("did not pass verification") && (await page.locator(".dowse-action").textContent()) === "Retry" && !during.files.some((f) => f.path === journalPath) && filtered.files[0]?.revision === (await digest(journalNew)),
		{ failedStatus, during: during.files.map((f) => f.path), filtered: filtered.files[0] },
	);
	server.mode = { kind: "normal" };
	await focusMain(page);
	await page.locator(".dowse-action").click();
	await waitForLabel(page, ["ready"], 120000);
	const repaired = await search(page, "sleeping well after moving house", 5);
	expect("retry replaces the damaged model and the new revision becomes searchable", repaired.files[0]?.path === journalPath && repaired.files[0]?.revision === (await digest(journalNew)), repaired.files.slice(0, 2).map((f) => f.path));
	await page.waitForTimeout(3000);

	await page.evaluate(() => (window as any).app.plugins.plugins.dowse.client.post({ type: "crash-for-test" }));
	await waitForLabel(page, ["failed"], 10000);
	const crashed = await engineStatus(page);
	await page.screenshot({ path: join(out, "worker-failed.png") });
	await focusMain(page);
	await page.locator(".dowse-action").click();
	await waitForLabel(page, ["ready"], 120000);
	const recovered = await engineStatus(page);
	expect(
		"a crashed engine worker shows a retry that restarts it from the saved index",
		crashed.model.kind === "failed" && crashed.model.retry === "restart" && recovered.passageInferences === 0 && (await search(page, "which medicine she takes in the morning")).files[0]?.path === "Family/Notes for Mum.md",
		{ crashed: crashed.model, recovered: recovered.counters },
	);
	await page.waitForTimeout(3000);
	await session.close();
	session = null;

	await rm(join(modelsDir, ENCODER.folderName), { recursive: true, force: true });
	session = await start();
	page = session.page;
	await waitForLabel(page, ["model-needed"]);
	server.mode = { kind: "normal", bytesPerSecond: 10 * MB };
	await openSetup(page);
	await click(page, "Download and set up");
	await waitForSetup(page, (s) => s.label === "acquiring" && megabytes(s.text) >= 20);
	await page.evaluate(() => (window as any).app.plugins.disablePlugin("dowse"));
	await page.waitForTimeout(800);
	const unloadSize = await sizeOf(partialModel);
	const modalsAfterDisable = await page.evaluate(() => document.querySelectorAll(".dowse-setup").length);
	expect("disabling during setup stops the transfer, keeps the partial file, frees the lock, and closes the setup screen", modelRequests().at(-1)!.closedEarly && unloadSize >= 20 * MB && (await sizeOf(lockFile)) === -1 && modalsAfterDisable === 0, { unloadSize, lock: await sizeOf(lockFile), modalsAfterDisable });
	await page.evaluate(() => (window as any).app.plugins.enablePlugin("dowse"));
	await pluginLoaded(page);
	await openPane(page);
	await waitForLabel(page, ["model-needed"]);
	server.mode = { kind: "normal" };
	await openSetup(page);
	await click(page, "Download and set up");
	await waitForSetup(page, (s) => s.label === "indexing" || s.label === "ready", 120000);
	expect("re-enabling and setting up again resumes the partial file", modelRequests().at(-1)!.range === `bytes=${unloadSize}-`, modelRequests().at(-1));
	await closeModal(page);
	await waitForLabel(page, ["ready"], 120000);
	await page.waitForTimeout(3000);
	await session.close();
	session = null;

	session = await start({ args: OFFLINE_ARGS });
	page = session.page;
	await waitForLabel(page, ["ready"]);
	expect("after setup, search works offline", (await page.evaluate(() => fetch("https://example.com").then(() => "reachable", () => "blocked"))) === "blocked" && (await typeInPane(page, "which medicine she takes in the morning", { waitMs: 150 })).rows[0] === "Family/Notes for Mum.md");
	await session.close();
	session = null;

	await rm(live.dataDir, { recursive: true, force: true });
	session = await launch(live, PORT, OFFLINE_ARGS);
	captureConsole(session.page, consoleErrors);
	page = session.page;
	await pluginLoaded(page);
	await openPane(page);
	await waitForLabel(page, ["model-needed"]);
	await openSetup(page);
	await click(page, "Download and set up");
	const offline = await waitForSetup(page, (s) => s.label === "failed");
	expect("an offline fresh install explains that huggingface.co is unreachable and keeps filters working", offline.text === "Could not reach huggingface.co. Check the internet connection and retry, or import the files from a folder." && (await search(page, "path:Daily")).kind === "matching", offline);
	await page.screenshot({ path: join(out, "setup-03-offline.png") });
	await importInSetup(page, live.modelSource);
	await waitForSetup(page, (s) => s.label === "indexing" || s.label === "ready", 120000);
	await closeModal(page);
	await waitForLabel(page, ["ready"], 120000);
	expect("offline, the local import sets up concept search", (await typeInPane(page, "why do new customers stop using the product", { waitMs: 150 })).kind === "results");
	await page.waitForTimeout(2000);
	await session.close();
	session = null;

	const unexpected = consoleErrors.filter((e) => !/ERR_PROXY_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|status of 503|ERR_CONNECTION_RESET|ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONTENT_LENGTH_MISMATCH|crash-for-test/.test(e));
	step("console errors", consoleErrors);
	expect("no console errors except the induced network failures", unexpected.length === 0, unexpected);
} finally {
	await session?.close();
	await server.close();
}
expect("your Obsidian untouched", JSON.stringify(guardBefore) === JSON.stringify(await userGuard(live)));
await finish(join(out, "m3-report.json"));
