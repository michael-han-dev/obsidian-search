import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { blake3 } from "hash-wasm";
import type { Page } from "playwright-core";
import {
	FILTER_CASES,
	FILTER_NOTES,
	NATIVE_TEXT_NOTES,
	NATIVE_TEXT_QUERIES,
	ORDER_FIRST_SIX,
	ORDER_NOTES,
	PARSE_ERRORS,
	PROPERTY_NOTES,
	LONG_LINE,
	SHAPE_FIRST_PASSAGE,
	SHAPE_NOTES,
	SIBLING_NOTES,
	TWIN_NOTES,
} from "../../test/fixtures/e2e.ts";
import { TAG_NOTES, TAG_QUERIES } from "../../test/fixtures/tags.ts";
import { NOTES, noteText, QUERIES } from "../../test/fixtures/vault.ts";
import { captureConsole, engineStatus, type Found, installModel, launch, liveRoot, nativeSearch, openAndWait, prepare, search, type Session, typeInPane, userGuard, writeNotes } from "./harness.ts";
import { createReport, walk } from "./report.ts";

const live = liveRoot(resolve(process.argv[2] ?? "dev-assets/live-m2"));
const out = join(live.root, "results");
const sibling = join(live.root, "sibling");
const vault2 = join(live.root, "vault2");
const { step, expect, finish } = createReport();
const consoleErrors: string[] = [];
const sorted = (xs: readonly string[]) => [...xs].sort();
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

const paths = (r: Found) => r.files.map((f) => f.path);

async function until(page: Page, text: string, check: (r: Found) => boolean, timeout = 30000): Promise<{ ms: number; result: Found }> {
	const started = Date.now();
	for (;;) {
		const result = await search(page, text);
		if (check(result)) return { ms: Date.now() - started, result };
		if (Date.now() - started > timeout) return { ms: -1, result };
		await page.waitForTimeout(25);
	}
}

async function settled(page: Page) {
	await page.waitForFunction(
		() => {
			const s = (window as any).app.plugins.plugins.dowse.status;
			return s?.model.kind === "loaded" && s.coverage.embeddedSources === s.coverage.totalSources;
		},
		null,
		{ timeout: 60000, polling: 50 },
	);
	await page.waitForTimeout(500);
	return engineStatus(page);
}

const vaultNotes = (): Record<string, string> => ({
	...Object.fromEntries(NOTES.map((n) => [n.path, noteText(n)])),
	...TAG_NOTES,
	...PROPERTY_NOTES,
	...FILTER_NOTES,
	...ORDER_NOTES,
	...TWIN_NOTES,
	...SHAPE_NOTES,
	...NATIVE_TEXT_NOTES,
});

await mkdir(out, { recursive: true });
const guardBefore = await userGuard(live);
let session: Session | null = null;
try {
	await prepare(live, { fresh: true });
	for (const dir of [sibling, vault2]) await rm(dir, { recursive: true, force: true });
	await writeNotes(live.vault, vaultNotes());
	await writeNotes(sibling, SIBLING_NOTES);

	session = await launch(live, 9343);
	let page = session.page;
	captureConsole(page, consoleErrors);
	step("enable to model-needed ms", await openAndWait(session, { trust: true, label: "model-needed" }));
	const shownAt = Date.now();
	const noModelImmediate = await search(page, "tag:work");
	const noModelNative = await nativeSearch(page, "tag:work");
	const noModelConverged = await until(page, "tag:work", (r) => r.kind === "matching" && same(paths(r), noModelNative), 15000);
	step("new vault: tag:work right after enable, and ms from enable until it agrees with native", { immediately: noModelImmediate.files.length, native: noModelNative.length, atMostMs: noModelConverged.ms < 0 ? -1 : Date.now() - shownAt });
	const noModelTag = noModelConverged.result;
	const noModelRanked = await search(page, "tag:work notes");
	const noModelPane = await typeInPane(page, "tag:urgent", { waitMs: 250 });
	const noModelStatus = await engineStatus(page);
	expect(
		"filters list notes before any model, and words answer not-ready",
		noModelTag.kind === "matching" && noModelTag.files.length > 0 && same(paths(noModelTag), noModelNative) && noModelRanked.kind === "not-ready" && noModelPane.kind === "matching" && noModelPane.rows.length > 0 && noModelStatus.model.kind === "model-needed" && noModelStatus.passageInferences === 0,
		{ tag: noModelTag.files.length, native: noModelNative.length, ranked: noModelRanked.kind, pane: noModelPane.kind, status: noModelStatus },
	);
	await session.close();

	await installModel(live);
	session = await launch(live, 9343);
	page = session.page;
	captureConsole(page, consoleErrors);
	step("first indexing ms", await openAndWait(session));
	step("status", await engineStatus(page));

	const narrowsTo = (ranked: Found, native: string[]) => ranked.kind === "results" && ranked.coverage?.totalSources === native.length && paths(ranked).every((p) => native.includes(p));
	const matrix: { query: string; native: string[]; dowse: string[]; dowseRanked: string[]; eligible: number | undefined; match: boolean; matchRanked: boolean }[] = [];
	for (const query of TAG_QUERIES) {
		const native = await nativeSearch(page, query);
		const dowse = paths(await search(page, query));
		const ranked = await search(page, `${query} notes`);
		matrix.push({ query, native, dowse: sorted(dowse), dowseRanked: sorted(paths(ranked)), eligible: ranked.coverage?.totalSources, match: same(native, dowse), matchRanked: narrowsTo(ranked, native) });
	}
	await writeFile(join(out, "tag-matrix.json"), `${JSON.stringify(matrix, null, 1)}\n`);
	step("tag queries matching native, filter only", `${matrix.filter((m) => m.match).length} of ${matrix.length}`);
	step("tag queries matching native, with words", `${matrix.filter((m) => m.matchRanked).length} of ${matrix.length}`);
	for (const m of matrix) expect(`native parity ${m.query}: the same notes, and with words the eligible set is exactly native's`, m.match && m.matchRanked, { native: m.native, dowse: m.dowse, ranked: m.dowseRanked, eligible: m.eligible });

	for (const query of NATIVE_TEXT_QUERIES) {
		const native = await nativeSearch(page, `path:Native/ ${query}`);
		const dowse = paths(await search(page, `path:Native/ ${query}`));
		const ranked = await search(page, `path:Native/ ${query} notes`);
		expect(`native parity ${query}: the same notes, and with words the eligible set is exactly native's`, same(native, dowse) && narrowsTo(ranked, native), { native, dowse, ranked: paths(ranked), eligible: ranked.coverage?.totalSources });
	}
	for (const [query, want] of Object.entries(FILTER_CASES)) {
		const got = paths(await search(page, `path:Filters/ ${query}`));
		expect(`filter ${query}`, same(got, want), got);
	}
	const expected: Record<string, string[]> = {
		'file:caching "cache-key"': ["Engineering/Caching strategy.md"],
		'file:"API reliability.md"': ["Engineering/API reliability.md", "Filters/Engineering/API reliability.md"],
		"file:readme": ["Projects/Alpha/README.md", "Projects/Beta/README.md", "Order/a/README.md", "Order/b/README.md"],
		'path:"Projects/Beta"': ["Projects/Beta/README.md"],
		'"C++" -draft': ["Engineering/C++ templates.md"],
		'path:Props/ property.status:"in progress"': ["Props/Active plan.md", "Props/Quoted priority.md"],
		"path:Props/ property.priority:2": ["Props/Active plan.md"],
		'path:Props/ property.priority:"2"': ["Props/Quoted priority.md"],
		"path:Props/ property.done:true": ["Props/Quoted priority.md"],
		"path:Props/ property.owners:3": ["Props/Active plan.md"],
		"path:Props -draft": [],
		"file:café": ["Notes/Café résumé.md", "Filters/Inbox/Café résumé.md"],
	};
	for (const [query, want] of Object.entries(expected)) {
		const got = paths(await search(page, query));
		expect(`filter ${query}`, same(got, want), got);
	}
	const nativeInfo: Record<string, { native: string[]; dowse: string[] }> = {};
	for (const query of ["file:api", "file:readme", "file:.md", 'path:"Projects/Beta"', '"cache-key"', '"cache key"', "file:café", "-draft path:Props"]) {
		nativeInfo[query] = { native: await nativeSearch(page, query), dowse: sorted(paths(await search(page, query))) };
	}
	await writeFile(join(out, "native-other-filters.json"), `${JSON.stringify(nativeInfo, null, 1)}\n`);

	for (const [input, error] of Object.entries(PARSE_ERRORS)) {
		const r = await search(page, input);
		expect(`error ${input}`, r.kind === "invalid" && r.error === error, r.error ?? r.kind);
	}
	const colons = await search(page, "meeting at 10:30 - Note: ratio 3:1");
	expect("words with colons stay meaning text", colons.kind === "results", colons.kind);
	const empty = await search(page, "");
	expect("empty query", empty.kind === "empty", empty.kind);

	const order = await search(page, 'path:Order/ "shared line"', 6);
	expect("matching files sort by title, path, then ID in code-point order", JSON.stringify(paths(order)) === JSON.stringify(ORDER_FIRST_SIX) && order.total === 7, { order: paths(order), total: order.total });
	expect(
		"a quoted match shows the block holding it",
		JSON.stringify(order.files[0]?.passages) === JSON.stringify([{ headingPath: ["T"], text: "second shared line", span: { start: { line: 5, column: 0 }, end: { line: 5, column: 18 } } }]),
		order.files[0]?.passages,
	);

	const twins = await search(page, "path:Twins/ lanterns", 10);
	const twinB = await search(page, 'path:"Twins/b/" lanterns', 10);
	expect(
		"identical notes keep separate identities",
		same(paths(twins), ["Twins/a/Same.md", "Twins/b/Same.md"]) && twins.files[0]?.revision === twins.files[1]?.revision && JSON.stringify(paths(twinB)) === JSON.stringify(["Twins/b/Same.md"]),
		{ twins: paths(twins), twinB: paths(twinB) },
	);

	const shapes = await search(page, "path:Shapes/ constants in code", 1);
	const shapeTexts = shapes.files[0]?.passages.map((p) => p.text) ?? [];
	expect(
		"passage text is rebuilt from the note's blocks, and the long line comes back as whole-word pieces",
		shapeTexts.includes(SHAPE_FIRST_PASSAGE) && shapeTexts.filter((t) => t !== SHAPE_FIRST_PASSAGE).every((t) => /^word( word)*$/.test(t) && t.length < LONG_LINE.length),
		shapeTexts.map((t) => t.slice(0, 60)),
	);

	const narrowed = await search(page, "tag:engineering avoid charging a customer twice", 1);
	expect("filter narrows before ranking", JSON.stringify(paths(narrowed)) === JSON.stringify(["Engineering/API reliability.md"]) && narrowed.coverage?.totalSources === 1, narrowed);

	const paneTag = await typeInPane(page, "tag:work", { waitMs: 250 });
	await page.screenshot({ path: join(out, "m2-01-matching.png") });
	expect("pane matching files", paneTag.kind === "matching" && paneTag.summary.startsWith("Matching files: ") && paneTag.rows.length === 20, paneTag);
	const paneRanked = await typeInPane(page, "tag:engineering avoid charging a customer twice", { waitMs: 250 });
	expect("pane ranked with filter", paneRanked.kind === "results" && paneRanked.rows[0] === "Engineering/API reliability.md" && paneRanked.rows.length === 1, paneRanked);
	const paneError = await typeInPane(page, "collection:docs", { waitMs: 250 });
	await page.screenshot({ path: join(out, "m2-02-error.png") });
	expect("pane collection error", paneError.kind === "invalid" && paneError.summaryIsError && paneError.summary.includes("collection:") && paneError.rows.length === 0, paneError);
	const paneQuote = await typeInPane(page, '"unclosed', { waitMs: 250 });
	expect("pane unclosed quote error", paneQuote.kind === "invalid" && paneQuote.summary.startsWith("Close the quote"), paneQuote);

	const cacheNote = NOTES.find((n) => n.path === "Engineering/Caching strategy.md")!;
	const cacheLines = noteText(cacheNote).split("\n");
	let block = cacheLines.findIndex((l) => l.includes("cache-key"));
	while (block > 0 && cacheLines[block - 1]!.trim() !== "") block--;
	await typeInPane(page, 'file:caching "cache-key"', { waitMs: 250 });
	await page.locator(".dowse-input").press("Enter");
	await page.waitForTimeout(800);
	const opened = await page.evaluate(() => {
		const app = (window as any).app;
		return { path: app.workspace.getActiveFile()?.path, line: app.workspace.activeEditor?.editor?.getCursor().line + 1 };
	});
	expect("open literal match at its block", opened.path === cacheNote.path && opened.line === block + 1, { opened, expectedLine: block + 1 });

	const quokka = await search(page, "quokka migration ledger island crossing", 50);
	const quokkaTag = await search(page, "tag:quokka");
	const allExist = await page.evaluate((ps) => ps.every((p) => (window as any).app.vault.getAbstractFileByPath(p)?.extension === "md"), paths(quokka));
	await page.waitForTimeout(3000);
	const indexText = (await Promise.all((await walk(join(live.dataDir, "vaults"))).filter((f) => f.endsWith(".json")).map((f) => readFile(f, "utf8")))).join("");
	step("sibling scope", { results: paths(quokka).slice(0, 3), quokkaTag: paths(quokkaTag), allInVault: allExist, indexMentionsQuokka: indexText.toLowerCase().includes("quokka") });
	expect("sibling folder ignored", allExist && quokkaTag.files.length === 0 && !indexText.toLowerCase().includes("quokka") && paths(quokka).every((p) => !p.toLowerCase().includes("quokka")));

	const everything = await search(page, "file:.md");
	const mismatched: string[] = [];
	for (const f of everything.files) if (f.revision !== `blake3:${await blake3(await readFile(join(live.vault, f.path)))}`) mismatched.push(f.path);
	step("worker revisions checked", everything.files.length);
	expect("worker BLAKE3 equals raw-byte BLAKE3", everything.files.length === Object.keys(vaultNotes()).length && mismatched.length === 0, mismatched);

	let checked = 0;
	const offsetErrors: unknown[] = [];
	for (const q of [...QUERIES.map((x) => x.text), "path:Shapes/ constants in code", "path:Filters/ templates in C++"]) {
		for (const f of (await search(page, q, 5)).files) {
			const lines = (await readFile(join(live.vault, f.path), "utf8")).split(/\r\n|\r|\n/);
			for (const p of f.passages) {
				const text = p.text.split("\n");
				const oneLine = p.span.start.line === p.span.end.line;
				const first = lines[p.span.start.line - 1]!.slice(p.span.start.column, oneLine ? p.span.end.column : undefined);
				const last = oneLine ? first : lines[p.span.end.line - 1]!.slice(0, p.span.end.column);
				checked++;
				if (first !== text[0] || last !== text.at(-1)) offsetErrors.push({ path: f.path, span: p.span, first: first.slice(0, 80), last: last.slice(0, 80), text: [text[0]?.slice(0, 80), text.at(-1)?.slice(0, 80)] });
			}
		}
	}
	step("passage spans checked", checked);
	expect("passage spans match the file", checked > 0 && offsetErrors.length === 0, offsetErrors.slice(0, 3));

	const freshness: { tagMs: number; conceptMs: number; embedded: number }[] = [];
	for (let i = 0; i < 5; i++) {
		const before = await settled(page);
		const phrase = `frostlog${i}`;
		const target = "Garden/Tomatoes.md";
		await page.evaluate(
			async ({ target, phrase, i }) => {
				const app = (window as any).app;
				const file = app.vault.getAbstractFileByPath(target);
				await app.vault.modify(file, `${await app.vault.read(file)}\n\nA late frost damaged the seedlings, ${phrase}. #fresh${i}\n`);
			},
			{ target, phrase, i },
		);
		const saved = Date.now();
		let tagMs = -1;
		let conceptMs = -1;
		while ((tagMs < 0 || conceptMs < 0) && Date.now() - saved < 30000) {
			if (tagMs < 0 && paths(await search(page, `tag:fresh${i}`)).includes(target)) tagMs = Date.now() - saved;
			const r = await search(page, `"${phrase}" frost damaged the seedlings`);
			if (conceptMs < 0 && r.kind === "results" && r.files[0]?.path === target && r.files[0].passages.some((p) => p.text.includes(phrase))) conceptMs = Date.now() - saved;
			await page.waitForTimeout(25);
		}
		freshness.push({ tagMs, conceptMs, embedded: (await settled(page)).passageInferences - before.passageInferences });
	}
	step("save to searchable ms, from the save, with polling", freshness);
	expect("edits become searchable within 5 s", freshness.every((f) => f.tagMs >= 0 && f.tagMs < 5000 && f.conceptMs >= 0 && f.conceptMs < 5000), freshness);
	expect("an appended paragraph embeds one passage and reuses the rest", freshness.every((f) => f.embedded === 1), freshness.map((f) => f.embedded));

	const pizza = join(live.vault, "Cooking/Pizza dough.md");
	await writeFile(`${pizza}.tmp-dowse`, "# Pizza dough\n\nUse semolina flour on the peel so the dough slides off.\n");
	await rename(`${pizza}.tmp-dowse`, pizza);
	const atomic = await until(page, '"semolina flour"', (r) => paths(r).includes("Cooking/Pizza dough.md"));
	const atomicConcept = await until(page, '"semolina" flour on the peel', (r) => r.kind === "results" && r.files.length === 1);
	expect("atomic save is picked up", atomic.ms >= 0 && atomicConcept.ms >= 0, { atomic: atomic.ms, concept: atomicConcept.ms });

	await page.evaluate(async () => {
		await (window as any).app.vault.create("Garden/Upper case.MD", "# Upper case\n\nDragonfly over the pond at noon.\n");
	});
	const upperCreated = await until(page, '"dragonfly"', (r) => paths(r).includes("Garden/Upper case.MD"));
	await page.evaluate(async () => {
		const app = (window as any).app;
		await app.vault.modify(app.vault.getAbstractFileByPath("Garden/Upper case.MD"), "# Upper case\n\nDragonfly and a heron over the pond.\n");
	});
	const upperModified = await until(page, '"heron"', (r) => paths(r).includes("Garden/Upper case.MD"));
	await page.evaluate(async () => {
		const app = (window as any).app;
		await app.vault.delete(app.vault.getAbstractFileByPath("Garden/Upper case.MD"));
	});
	const upperRemoved = await until(page, '"heron"', (r) => !paths(r).includes("Garden/Upper case.MD"));
	expect("notes with an uppercase extension are indexed, updated, and removed", upperCreated.ms >= 0 && upperModified.ms >= 0 && upperRemoved.ms >= 0, { created: upperCreated.ms, modified: upperModified.ms, removed: upperRemoved.ms });

	const beforeRename = await settled(page);
	await page.evaluate(async () => {
		const app = (window as any).app;
		await app.vault.createFolder("Archive/Moved").catch(() => {});
		await app.fileManager.renameFile(app.vault.getAbstractFileByPath("Health/Sleep hygiene.md"), "Archive/Moved/Sleep hygiene.md");
		await app.fileManager.renameFile(app.vault.getAbstractFileByPath("Music"), "Hobbies");
	});
	const movedNote = await until(page, 'file:"Sleep hygiene"', (r) => JSON.stringify(paths(r)) === JSON.stringify(["Archive/Moved/Sleep hygiene.md"]));
	const movedFolder = await until(page, 'path:"Hobbies/"', (r) => JSON.stringify(paths(r)) === JSON.stringify(["Hobbies/Guitar practice.md"]));
	const afterRename = await settled(page);
	const movedConcept = await until(page, "tips for falling asleep faster", (r) => r.files[0]?.path === "Archive/Moved/Sleep hygiene.md");
	const oldFolder = await search(page, 'path:"Music/"');
	expect(
		"moving a note and a folder reuses every vector",
		movedNote.ms >= 0 && movedFolder.ms >= 0 && movedConcept.ms >= 0 && oldFolder.files.length === 0 && afterRename.passageInferences === beforeRename.passageInferences,
		{ movedNote: movedNote.ms, movedFolder: movedFolder.ms, movedConcept: movedConcept.ms, oldFolder: paths(oldFolder), inferences: [beforeRename.passageInferences, afterRename.passageInferences] },
	);

	await page.evaluate(async () => {
		const app = (window as any).app;
		await app.vault.delete(app.vault.getAbstractFileByPath("Travel/Japan trip.md"));
	});
	const deleted = await until(page, "things to see in Tokyo", (r) => r.kind === "results" && !paths(r).includes("Travel/Japan trip.md"));
	const deletedFilter = await search(page, 'file:"Japan trip"');
	expect("delete leaves results", deleted.ms >= 0 && deletedFilter.files.length === 0, { ms: deleted.ms });

	const missedPath = "Home/Moving checklist.md";
	await page.evaluate((path) => {
		const plugin = (window as any).app.plugins.plugins.dowse;
		const stale = { collectionId: "vault", path, text: "# Moving checklist\n\nStale text about a walrus.", metadata: { aliases: [], tags: [], properties: {} } };
		plugin.client.post({ type: "sync", files: [stale], removed: [], complete: false });
		plugin.sent.set(path, "0:0");
		plugin.lastReconcile = 0;
	}, missedPath);
	const staleSeen = await until(page, '"walrus"', (r) => paths(r).includes(missedPath));
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	const recovered = await until(page, '"walrus"', (r) => r.kind === "matching" && r.files.length === 0);
	const realText = await search(page, '"forward mail"');
	expect("window focus restores a note whose change event was missed", staleSeen.ms >= 0 && recovered.ms >= 0 && paths(realText).includes(missedPath), { stale: staleSeen.ms, recovered: recovered.ms });
	await page.waitForTimeout(3000);
	await session.close();

	session = await launch(live, 9343);
	page = session.page;
	captureConsole(page, consoleErrors);
	step("restart to ready ms", await openAndWait(session));
	const afterRestart = await search(page, "tips for falling asleep faster", 3);
	const restartStatus = await engineStatus(page);
	expect(
		"restart restores the index without embedding and keeps edits, renames, and deletes",
		restartStatus.passageInferences === 0 && afterRestart.files[0]?.path === "Archive/Moved/Sleep hygiene.md" && (await search(page, 'file:"Japan trip"')).files.length === 0,
		{ top: paths(afterRestart), inferences: restartStatus.passageInferences },
	);
	await session.close();

	const vault1Dir = join(live.dataDir, "vaults", (await readdir(join(live.dataDir, "vaults")))[0]!);
	const vault1Pointer = JSON.parse(await readFile(join(vault1Dir, "index.json"), "utf8"));
	await writeFile(join(vault1Dir, "index.json"), JSON.stringify({ ...vault1Pointer, meta: JSON.stringify({ ...JSON.parse(vault1Pointer.meta), extraction: "obsidian-markdown@1|112|32" }) }));
	session = await launch(live, 9343);
	page = session.page;
	captureConsole(page, consoleErrors);
	step("older extraction version to ready ms", await openAndWait(session));
	const reextracted = await settled(page);
	const reextractedSearch = await search(page, "tips for falling asleep faster", 1);
	expect(
		"an older extraction version re-extracts every note without embedding",
		reextracted.passageInferences === 0 && reextracted.coverage.totalSources === Object.keys(vaultNotes()).length - 1 && paths(reextractedSearch)[0] === "Archive/Moved/Sleep hygiene.md",
		{ status: reextracted, top: paths(reextractedSearch) },
	);
	await page.waitForTimeout(3000);
	await session.close();

	const tomato = join(live.vault, "Garden/Tomatoes.md");
	await writeFile(tomato, `${await readFile(tomato, "utf8")}\n\nMarked while closed #closedtag\n`);
	await writeNotes(live.vault, { "Inbox/Added while closed.md": "---\ntags: [closedtag]\n---\n# Added while closed\n\nA heron nested by the pond while the app was shut.\n" });
	await rm(join(live.vault, "Health/Running injuries.md"));
	await mkdir(join(live.vault, "Reading/Books"), { recursive: true });
	await rename(join(live.vault, "Reading/Thinking Fast and Slow.md"), join(live.vault, "Reading/Books/Thinking Fast and Slow.md"));
	session = await launch(live, 9343);
	page = session.page;
	captureConsole(page, consoleErrors);
	step("start after closed changes to ready ms", await openAndWait(session));
	const closedTag = await until(page, "tag:closedtag", (r) => same(paths(r), ["Garden/Tomatoes.md", "Inbox/Added while closed.md"]));
	const closedConcept = await until(page, "a bird nesting near the pond", (r) => r.files[0]?.path === "Inbox/Added while closed.md");
	const closedDeleted = await search(page, 'file:"Running injuries"');
	const closedMoved = await until(page, "the book about two systems of thinking", (r) => r.files[0]?.path === "Reading/Books/Thinking Fast and Slow.md");
	expect("start reconciles changes made while closed", closedTag.ms >= 0 && closedConcept.ms >= 0 && closedDeleted.files.length === 0 && closedMoved.ms >= 0, {
		tag: paths(closedTag.result),
		concept: closedConcept.ms,
		deleted: paths(closedDeleted),
		moved: closedMoved.ms,
	});
	await page.waitForTimeout(3000);
	await session.close();

	await writeNotes(vault2, { "Second vault note.md": "# Second vault note\n\nLighthouse keeper rota for the winter.\n", "Other.md": "# Other\n\nTide gauges.\n" });
	const index1Before = (await walk(join(live.dataDir, "vaults"))).map((f) => relative(live.dataDir, f));
	await writeFile(join(live.userData, "obsidian.json"), JSON.stringify({ vaults: { "0123456789abcdef": { path: live.vault, ts: Date.now() }, fedcba9876543210: { path: vault2, ts: Date.now(), open: true } } }));
	await mkdir(join(vault2, ".obsidian", "plugins", "dowse"), { recursive: true });
	await cp(join(live.vault, ".obsidian", "plugins", "dowse"), join(vault2, ".obsidian", "plugins", "dowse"), { recursive: true });
	await writeFile(join(vault2, ".obsidian", "community-plugins.json"), JSON.stringify(["dowse"]));
	session = await launch(live, 9343);
	page = session.page;
	captureConsole(page, consoleErrors);
	step("second vault to ready ms", await openAndWait(session, { trust: true }));
	const second = await search(page, "lighthouse keeper rota", 10);
	await page.waitForTimeout(3000);
	await session.close();
	const vaultDirs = await readdir(join(live.dataDir, "vaults"));
	const indexes = await Promise.all(vaultDirs.map(async (d) => ({ dir: d, sources: (JSON.parse(JSON.parse(await readFile(join(live.dataDir, "vaults", d, "index.json"), "utf8")).meta).sources as { doc: { path: string } }[]).map((s) => s.doc.path) })));
	step("indexes", indexes.map((i) => ({ dir: i.dir.replace(/-[0-9a-f]{16}$/, "-<hash>"), notes: i.sources.length })));
	const second2 = indexes.find((i) => i.dir.startsWith("vault2-"));
	expect(
		"second vault has its own index",
		vaultDirs.length === 2 && same(second2?.sources ?? [], ["Second vault note.md", "Other.md"]) && paths(second)[0] === "Second vault note.md" && paths(second).every((p) => ["Second vault note.md", "Other.md"].includes(p)),
		{ vaultDirs, second: paths(second) },
	);
	const index1After = (await walk(join(live.dataDir, "vaults"))).filter((f) => !f.includes("vault2-")).map((f) => relative(live.dataDir, f));
	expect("first vault's index untouched by the second", JSON.stringify(index1After) === JSON.stringify(index1Before), { index1Before, index1After });

	const v2dir = join(live.dataDir, "vaults", vaultDirs.find((d) => d.startsWith("vault2-"))!);
	const pointer = JSON.parse(await readFile(join(v2dir, "index.json"), "utf8"));
	await writeFile(join(v2dir, "index.json"), JSON.stringify({ ...pointer, meta: pointer.meta.slice(0, 120) }));
	session = await launch(live, 9343);
	page = session.page;
	captureConsole(page, consoleErrors);
	step("damaged index to ready ms", await openAndWait(session));
	const rebuilt = await search(page, "lighthouse keeper rota", 10);
	await page.waitForTimeout(3000);
	await session.close();
	const rewritten = JSON.parse(JSON.parse(await readFile(join(v2dir, "index.json"), "utf8")).meta) as { sources: unknown[] };
	expect("damaged index rebuilds from the vault", paths(rebuilt)[0] === "Second vault note.md" && rewritten.sources.length === 2, { rebuilt: paths(rebuilt), sources: rewritten.sources.length });

	step("console errors", consoleErrors);
	expect("no console errors", consoleErrors.length === 0, consoleErrors);
} finally {
	await session?.close();
}
expect("your Obsidian untouched", JSON.stringify(guardBefore) === JSON.stringify(await userGuard(live)));
await finish(join(out, "m2-report.json"));
