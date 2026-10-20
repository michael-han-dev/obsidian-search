import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { Page } from "playwright-core";
import { HOSTILE_PATH, QUERIES } from "../../test/fixtures/vault.ts";
import { captureConsole, engineStatus, launch, liveRoot, OFFLINE_ARGS, openPane, pluginLoaded, prepare, search, type Session, statusOf, typeInPane, userGuard, waitForLabel, writeFixture } from "./harness.ts";
import { createReport, walk } from "./report.ts";

const live = liveRoot(resolve(process.argv[2] ?? "dev-assets/live"));
const out = join(live.root, "results");
const { step, expect, finish } = createReport();
const consoleErrors: string[] = [];

const OFFICIAL_LENGTHS = [0, 1, 63, 64, 65];
const LONG_LENGTHS = [1023, 1024, 1025, 2048, 8193];
const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n";

const liveWorkers = new Map<string, string>();

async function attach(session: Session) {
	captureConsole(session.page, consoleErrors);
	liveWorkers.clear();
	const cdp = await session.page.context().newCDPSession(session.page);
	cdp.on("Target.attachedToTarget", (e: any) => {
		if (e.targetInfo.type === "worker") liveWorkers.set(e.sessionId, e.targetInfo.title || e.targetInfo.url.slice(0, 20));
		void cdp.send("Runtime.runIfWaitingForDebugger" as any, undefined).catch(() => {});
	});
	cdp.on("Target.detachedFromTarget", (e: any) => liveWorkers.delete(e.sessionId));
	await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
}

const dataFiles = async () => (await walk(live.dataDir)).map((f) => relative(live.dataDir, f).replace(/vectors-[\w-]+/, "vectors-<id>").replace(/vault-[0-9a-f]{16}/, "vault-<hash>")).sort();

async function importFrom(settings: Page, folder: string, notice: string): Promise<number> {
	await settings.locator(".vertical-tab-content input[type=text]").fill(folder);
	const started = Date.now();
	await settings.locator(".vertical-tab-content button", { hasText: "Import" }).click();
	await settings.waitForFunction((want) => Array.from(document.querySelectorAll(".notice")).some((n) => n.textContent?.includes(want)), notice, { timeout: 120000 });
	return Date.now() - started;
}

async function openDowseSettings(session: Session): Promise<Page> {
	await session.page.evaluate(() => (window as any).app.commands.executeCommandById("app:open-settings"));
	for (let i = 0; i < 50; i++) {
		for (const candidate of session.browser.contexts().flatMap((c) => c.pages())) {
			if ((await candidate.title().catch(() => "")).startsWith("Settings")) {
				await candidate.locator(".vertical-tab-nav-item", { hasText: "Dowse" }).click();
				return candidate;
			}
		}
		await session.page.waitForTimeout(100);
	}
	throw new Error("Settings window did not open");
}

await mkdir(out, { recursive: true });
const guardBefore = await userGuard(live);
let session: Session | null = null;
try {
	await prepare(live, { fresh: true });
	await writeFixture(live);
	await mkdir(join(live.vault, "Hashing"), { recursive: true });
	for (const n of OFFICIAL_LENGTHS) await writeFile(join(live.vault, "Hashing", `official ${n}.md`), Buffer.from(Array.from({ length: n }, (_, i) => i % 251)));
	for (const n of LONG_LENGTHS) await writeFile(join(live.vault, "Hashing", `long ${n}.md`), LOREM.repeat(Math.ceil(n / LOREM.length)).slice(0, n));
	const official: { input_len: number; hash: string }[] = JSON.parse(await readFile("test/fixtures/blake3-vectors.json", "utf8"));
	const longHashes = execFileSync(
		"dev-assets/pyenv/bin/python",
		["-I", "-c", "import sys, blake3\nfor p in sys.argv[1:]: print(blake3.blake3(open(p, 'rb').read()).hexdigest())", ...LONG_LENGTHS.map((n) => join(live.vault, "Hashing", `long ${n}.md`))],
		{ encoding: "utf8" },
	).trim().split("\n");
	const expectedHashes: Record<string, string> = Object.fromEntries([
		...OFFICIAL_LENGTHS.map((n) => [`Hashing/official ${n}.md`, `blake3:${official.find((v) => v.input_len === n)!.hash.slice(0, 64)}`]),
		...LONG_LENGTHS.map((n, i) => [`Hashing/long ${n}.md`, `blake3:${longHashes[i]}`]),
	]);
	const noteCount = (await walk(live.vault)).filter((f) => f.endsWith(".md")).length;

	const missingModel = join(live.root, "model-missing");
	const corruptModel = join(live.root, "model-corrupt");
	await rm(missingModel, { recursive: true, force: true });
	await rm(corruptModel, { recursive: true, force: true });
	await mkdir(missingModel, { recursive: true });
	await mkdir(corruptModel, { recursive: true });
	const model = await readFile(join(live.modelSource, "model.onnx"));
	model.writeUInt8(model.readUInt8(model.length >> 1) ^ 0xff, model.length >> 1);
	await writeFile(join(corruptModel, "model.onnx"), model);
	await copyFile(join(live.modelSource, "vocab.txt"), join(corruptModel, "vocab.txt"));

	session = await launch(live, 9339);
	await attach(session);
	let page = session.page;
	await page.getByRole("button", { name: "Trust author and enable plugins" }).click();
	await pluginLoaded(page);
	step("versions", await page.evaluate(() => ({ obsidian: (window as any).require("electron").ipcRenderer.sendSync("version"), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node })));
	await openPane(page);
	await waitForLabel(page, ["model-needed"]);
	await page.screenshot({ path: join(out, "01-model-needed.png") });
	expect("pane asks for a model", (await statusOf(page)).text === "Concept search needs a model. Import it in Dowse settings.", await statusOf(page));
	expect("the engine runs in a worker", [...liveWorkers.values()].includes("dowse-engine"), [...liveWorkers.values()]);
	await page.locator(".dowse-input").fill("sourdough");
	await page.waitForTimeout(600);
	expect("search before a model answers not-ready", (await page.evaluate(() => (document.querySelector(".dowse-results") as HTMLElement).dataset.kind)) === "not-ready");

	const settings = await openDowseSettings(session);
	await importFrom(settings, missingModel, `model.onnx is missing from ${missingModel}`);
	await importFrom(settings, corruptModel, "model.onnx does not match the published SHA-256 checksum");
	expect("rejected imports install nothing", (await walk(join(live.dataDir, "models"))).length === 0, await walk(join(live.dataDir, "models")));
	await settings.screenshot({ path: join(out, "02-settings.png") });
	step("import ms", await importFrom(settings, live.modelSource, "Model imported"));
	await settings.screenshot({ path: join(out, "02b-imported.png") });
	await page.evaluate(() => (window as any).app.setting.close());
	step("model load plus first indexing ms", await waitForLabel(page, ["ready"], 300000));
	expect("every note is searchable", (await statusOf(page)).text === `Ready. ${noteCount} of ${noteCount} notes searchable.`, await statusOf(page));
	await page.screenshot({ path: join(out, "03-ready.png") });

	const tokenRows: { text: string; ids: number[] }[] = [
		...JSON.parse(await readFile("test/fixtures/tokenizer-reference.json", "utf8")),
		{ text: `Café x${"y".repeat(100)}`, ids: [7668, 100] },
		{ text: "cache-key", ids: [17053, 1011, 3145] },
	];
	const embedRows: { ids: number[]; embedding: number[] }[] = JSON.parse(await readFile("test/fixtures/reference-embeddings.json", "utf8")).rows;
	const probed = await page.evaluate(
		async ({ texts, inputs }) => {
			const r = await (window as any).app.plugins.plugins.dowse.client.probe(texts, inputs);
			return { ids: r.ids.map((x: number[]) => Array.from(x)), vectors: r.vectors.map((v: Float32Array) => Array.from(v)) };
		},
		{ texts: tokenRows.map((r) => r.text), inputs: embedRows.map((r) => r.ids) },
	);
	const tokenMismatches = tokenRows.filter((row, i) => JSON.stringify(probed.ids[i]) !== JSON.stringify(row.ids));
	expect("the packaged tokenizer matches Hugging Face on 493 texts", tokenRows.length === 493 && tokenMismatches.length === 0, tokenMismatches.slice(0, 3).map((r) => r.text));
	let worst = 0;
	embedRows.forEach((row, i) => row.embedding.forEach((x, d) => (worst = Math.max(worst, Math.abs(x - probed.vectors[i]![d]!)))));
	step("largest embedding difference from Python onnxruntime", worst);
	expect("the packaged runtime matches Python onnxruntime embeddings", embedRows.length === 8 && worst < 1e-5, worst);

	const ranks: string[] = [];
	for (const q of QUERIES) ranks.push(`${(await typeInPane(page, q.text, { waitMs: 200 })).rows.indexOf(q.expectedSource) + 1}:${q.text}`);
	step("fixture ranks", ranks);
	expect("every fixture query ranks its note first", ranks.every((r) => r.startsWith("1:")), ranks);
	const headings: string[] = [];
	for (const q of QUERIES.filter((x) => x.expectedHeading)) {
		const top = (await search(page, q.text, 5)).files[0];
		headings.push(`${top?.path === q.expectedSource ? top.passages[0]?.headingPath.at(-1) : "wrong note"}`);
	}
	expect("the best passage sits under the expected heading", JSON.stringify(headings) === JSON.stringify(QUERIES.filter((x) => x.expectedHeading).map((x) => x.expectedHeading)), headings);
	const ordering: string[] = [];
	for (const q of QUERIES) {
		const files = (await search(page, q.text, 20)).files;
		files.forEach((f, i) => {
			const scores = f.passages.map((p) => p.score);
			if (f.passages.length === 0 || f.passages.length > 3 || scores.some((s, j) => j > 0 && s > scores[j - 1]!)) ordering.push(`${q.text}: ${f.path}`);
			if (i > 0 && scores[0]! > files[i - 1]!.passages[0]!.score) ordering.push(`${q.text}: file order at ${f.path}`);
		});
	}
	expect("results keep at most three passages per note, best first, notes in score order", ordering.length === 0, ordering.slice(0, 3));

	const hostileChecks: Record<string, unknown> = {};
	const unsafe = () =>
		page.evaluate(() => ({
			elements: document.querySelectorAll(".dowse-view img, .dowse-view script, .dowse-view b").length,
			pwned: (window as any).__dowsePwned ?? null,
		}));
	await typeInPane(page, "marketing newsletter html", { waitMs: 200 });
	await page.screenshot({ path: join(out, "04-hostile.png") });
	hostileChecks.ranked = { ...(await unsafe()), passage: await page.evaluate((p) => document.querySelector(`.dowse-result[data-path="${CSS.escape(p)}"] .dowse-passage`)?.textContent?.slice(0, 60), HOSTILE_PATH) };
	const filtered = await typeInPane(page, '"onerror"', { waitMs: 200 });
	hostileChecks.filtered = { ...(await unsafe()), rows: filtered.rows, passage: await page.evaluate(() => document.querySelector(".dowse-passage")?.textContent?.slice(0, 60)) };
	const errored = await typeInPane(page, "[a:<img/src=x/onerror=window.__dowsePwned=1>]", { waitMs: 200 });
	hostileChecks.error = { ...(await unsafe()), summary: errored.summary };
	step("hostile markup", hostileChecks);
	const hostile = hostileChecks as { ranked: { elements: number; pwned: unknown; passage?: string }; filtered: { elements: number; pwned: unknown; rows: string[]; passage?: string }; error: { elements: number; pwned: unknown; summary: string } };
	expect(
		"note and query markup shows as text and never runs",
		[hostile.ranked, hostile.filtered, hostile.error].every((h) => h.elements === 0 && h.pwned === null) &&
			!!hostile.ranked.passage?.includes("<img") &&
			JSON.stringify(hostile.filtered.rows) === JSON.stringify([HOSTILE_PATH]) &&
			!!hostile.filtered.passage?.includes("<img") &&
			hostile.error.summary.includes("<img/src=x"),
		hostileChecks,
	);

	const hashed = await search(page, "path:Hashing/", 100);
	const hashMismatches = Object.entries(expectedHashes).filter(([path, hash]) => hashed.files.find((f) => f.path === path)?.revision !== hash);
	expect("the packaged worker's BLAKE3 matches official vectors and an independent implementation", hashed.files.length === 10 && hashMismatches.length === 0, hashMismatches);

	await typeInPane(page, "who to call when the main database goes down", { waitMs: 200 });
	await page.locator(".dowse-input").press("Enter");
	await page.waitForTimeout(800);
	const opened = await page.evaluate(() => {
		const app = (window as any).app;
		return { path: app.workspace.getActiveFile()?.path, cursorLine: app.workspace.activeEditor?.editor?.getCursor().line + 1 };
	});
	await page.screenshot({ path: join(out, "05-opened.png") });
	expect("Enter opens the note at the passage", opened.path === "Engineering/Incident handbook.md" && opened.cursorLine === 9, opened);

	await page.waitForTimeout(3000);
	const strayVaultFiles = (await walk(live.vault)).map((f) => relative(live.vault, f)).filter((f) => !f.endsWith(".md") && !f.startsWith(".obsidian/"));
	const pluginFiles = (await walk(join(live.vault, ".obsidian", "plugins", "dowse"))).map((f) => relative(live.vault, f)).sort();
	expect("the vault holds only notes and Obsidian config", strayVaultFiles.length === 0, strayVaultFiles);
	expect("the plugin folder holds only the release files", JSON.stringify(pluginFiles) === JSON.stringify([".obsidian/plugins/dowse/main.js", ".obsidian/plugins/dowse/manifest.json", ".obsidian/plugins/dowse/styles.css"]), pluginFiles);
	const expectedData = ["models/intfloat-e5-small-v2-ffb93f3/model.onnx", "models/intfloat-e5-small-v2-ffb93f3/vocab.txt", "vaults/vault-<hash>/index.json", "vaults/vault-<hash>/vectors-<id>.f32"];
	expect("the data folder holds the model and one index with one vectors file", JSON.stringify(await dataFiles()) === JSON.stringify(expectedData), await dataFiles());
	await session.close();

	session = await launch(live, 9339);
	await attach(session);
	page = session.page;
	await pluginLoaded(page);
	await openPane(page);
	step("restart to ready ms", await waitForLabel(page, ["ready"]));
	expect("restart restores the index without embedding", (await engineStatus(page)).passageInferences === 0, await engineStatus(page));
	expect("search works after restart", (await typeInPane(page, "avoid charging a customer twice", { waitMs: 200 })).rows[0] === "Engineering/API reliability.md");

	await page.evaluate(() => (window as any).app.workspace.getLeaf(false).openFile((window as any).app.vault.getAbstractFileByPath("Cooking/Pizza dough.md")));
	await page.waitForTimeout(300);
	await openPane(page);
	expect("the command focuses the search box", await page.evaluate(() => document.activeElement?.classList.contains("dowse-input") ?? false));
	await page.evaluate(() => {
		const app = (window as any).app;
		app.hotkeyManager.setHotkeys("dowse:open-search", [{ modifiers: ["Mod", "Shift"], key: "D" }]);
		app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Cooking/Pizza dough.md"));
	});
	await page.waitForTimeout(400);
	await page.evaluate(() => (window as any).app.workspace.activeEditor?.editor?.focus());
	const focusedBefore = await page.evaluate(() => document.activeElement?.classList.contains("dowse-input") ?? false);
	await page.keyboard.press("Meta+Shift+D");
	await page.waitForTimeout(400);
	expect("an assigned hotkey moves focus to the search box", !focusedBefore && (await page.evaluate(() => document.activeElement?.classList.contains("dowse-input") ?? false)));

	const indexBefore = (await walk(live.dataDir)).filter((f) => f.endsWith(".f32"));
	const pluginDir = join(live.vault, ".obsidian", "plugins", "dowse");
	await page.evaluate(() => (window as any).app.plugins.disablePlugin("dowse"));
	const manifest = JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8"));
	await writeFile(join(pluginDir, "manifest.json"), JSON.stringify({ ...manifest, version: "0.0.2" }));
	await writeFile(join(pluginDir, "main.js"), `${await readFile(join(pluginDir, "main.js"), "utf8")}\n// update marker\n`);
	await page.evaluate(async () => {
		await (window as any).app.plugins.loadManifests();
		await (window as any).app.plugins.enablePlugin("dowse");
	});
	await openPane(page);
	step("after update to ready ms", await waitForLabel(page, ["ready"]));
	expect(
		"a plugin update keeps the index",
		(await page.evaluate(() => (window as any).app.plugins.manifests.dowse.version)) === "0.0.2" &&
			JSON.stringify((await walk(live.dataDir)).filter((f) => f.endsWith(".f32"))) === JSON.stringify(indexBefore) &&
			(await typeInPane(page, "why are my plant leaves going yellow", { waitMs: 200 })).rows[0] === "Garden/Tomatoes.md",
	);

	expect("the engine worker runs while enabled", [...liveWorkers.values()].includes("dowse-engine"), [...liveWorkers.values()]);
	await page.evaluate(() => (window as any).app.plugins.disablePlugin("dowse"));
	await page.waitForTimeout(2500);
	expect("disabling removes the plugin and its worker", !(await page.evaluate(() => !!(window as any).app.plugins.plugins.dowse)) && ![...liveWorkers.values()].includes("dowse-engine"), [...liveWorkers.values()]);
	const vectorsAfterDisable = (await walk(live.dataDir)).filter((f) => f.endsWith(".f32"));
	const errorsBefore = consoleErrors.length;
	await page.evaluate(async () => {
		await (window as any).app.vault.create("Inbox/Written while disabled.md", "# Written while disabled\n\nThis note appears while Dowse is off.");
	});
	await page.waitForTimeout(3000);
	expect(
		"a note written while disabled causes no errors and no index write",
		consoleErrors.length === errorsBefore && JSON.stringify((await walk(live.dataDir)).filter((f) => f.endsWith(".f32"))) === JSON.stringify(vectorsAfterDisable),
		consoleErrors.slice(errorsBefore),
	);
	await page.evaluate(() => (window as any).app.plugins.enablePlugin("dowse"));
	await pluginLoaded(page);
	await openPane(page);
	step("re-enable to ready ms", await waitForLabel(page, ["ready"]));
	expect("search works after re-enabling", (await typeInPane(page, "tips for falling asleep faster", { waitMs: 200 })).rows[0] === "Health/Sleep hygiene.md");
	expect("the note written while disabled is indexed on re-enable", (await typeInPane(page, "a note that appears while the plugin is off", { waitMs: 200 })).rows[0] === "Inbox/Written while disabled.md");
	await page.waitForTimeout(3000);
	await session.close();

	session = await launch(live, 9339, OFFLINE_ARGS);
	await attach(session);
	page = session.page;
	expect("the network is blocked", (await page.evaluate(() => fetch("https://example.com").then(() => "reachable", () => "blocked"))) === "blocked");
	await pluginLoaded(page);
	await openPane(page);
	step("offline to ready ms", await waitForLabel(page, ["ready"]));
	expect("search works offline", (await typeInPane(page, "things to see in Tokyo", { waitMs: 200 })).rows[0] === "Travel/Japan trip.md");
	await session.close();

	const link = join(live.root, "vault-link");
	await rm(link, { force: true });
	await symlink(live.vault, link);
	await writeFile(join(live.userData, "obsidian.json"), JSON.stringify({ vaults: { "0123456789abcdef": { path: link, ts: Date.now(), open: true } } }));
	session = await launch(live, 9339);
	await attach(session);
	page = session.page;
	await pluginLoaded(page);
	await openPane(page);
	step("vault opened through a symlink to ready ms", await waitForLabel(page, ["ready"]));
	expect(
		"a vault opened through a symlink shares its index",
		(await engineStatus(page)).passageInferences === 0 && (await walk(join(live.dataDir, "vaults"))).filter((f) => f.endsWith("index.json")).length === 1,
		await engineStatus(page),
	);
	await session.close();

	const indexJson = (await walk(join(live.dataDir, "vaults"))).find((f) => f.endsWith("index.json"))!;
	await writeFile(indexJson, JSON.stringify({ vectors: "../../escape.f32", meta: "{}" }));
	session = await launch(live, 9339);
	await attach(session);
	page = session.page;
	await pluginLoaded(page);
	await openPane(page);
	step("index pointing outside its folder to ready ms", await waitForLabel(page, ["ready"], 300000));
	const rebuilt = await engineStatus(page);
	expect("an index pointing outside its folder is ignored and rebuilt", rebuilt.passageInferences > 0 && (await typeInPane(page, "things to see in Tokyo", { waitMs: 200 })).rows[0] === "Travel/Japan trip.md", rebuilt);
	await page.waitForTimeout(3000);
	await session.close();
	expect("the rebuilt index is written back in place", JSON.stringify(await dataFiles()) === JSON.stringify(expectedData), await dataFiles());

	const spanIndexJson = (await walk(join(live.dataDir, "vaults"))).find((f) => f.endsWith("index.json"))!;
	const spanPointer = JSON.parse(await readFile(spanIndexJson, "utf8"));
	const spanMeta = JSON.parse(spanPointer.meta);
	const withPassages = spanMeta.sources.find((s: any) => s.passages?.length > 0);
	if (!withPassages) throw new Error("no indexed source with passages to corrupt");
	withPassages.passages[0].span.end.line = 999999;
	await writeFile(spanIndexJson, JSON.stringify({ ...spanPointer, meta: JSON.stringify(spanMeta) }));
	session = await launch(live, 9339);
	await attach(session);
	page = session.page;
	await pluginLoaded(page);
	await openPane(page);
	step("index with an out-of-range span to ready ms", await waitForLabel(page, ["ready"], 300000));
	const spanRebuilt = await engineStatus(page);
	expect(
		"an index with an out-of-range span is rejected and rebuilt",
		spanRebuilt.passageInferences > 0 && (await typeInPane(page, "things to see in Tokyo", { waitMs: 200 })).rows[0] === "Travel/Japan trip.md",
		spanRebuilt,
	);
	await page.waitForTimeout(3000);
	await session.close();
	expect("the span-rejected index is written back in place", JSON.stringify(await dataFiles()) === JSON.stringify(expectedData), await dataFiles());

	const realDataRoot = join(homedir(), "Library", "Application Support", "dowse");
	const realBefore = await walk(realDataRoot);
	const realModel = realBefore.find((f) => f.startsWith("models/"));
	expect("this machine has no real Dowse install, so launching without the data override is safe", realModel === undefined, realBefore);
	if (realModel === undefined) {
		session = await launch(live, 9339, [], { scratchData: false });
		await attach(session);
		page = session.page;
		await pluginLoaded(page);
		const defaultRoot = await page.evaluate(() => (window as any).app.plugins.plugins.dowse.root);
		await session.close();
		const realAfter = await walk(realDataRoot);
		expect(
			"without an override the data folder is the home folder's Library/Application Support/dowse, and a run without a model writes nothing there",
			defaultRoot === realDataRoot && JSON.stringify(realAfter) === JSON.stringify(realBefore),
			{ defaultRoot, before: realBefore, after: realAfter },
		);
	}

	session = await launch(live, 9339);
	await attach(session);
	page = session.page;
	await pluginLoaded(page);
	const deleteSettings = await openDowseSettings(session);
	await deleteSettings.locator(".setting-item button", { hasText: "Delete local data" }).click();
	await deleteSettings.getByRole("button", { name: "Delete", exact: true }).click();
	let importDisabled = false;
	for (let i = 0; i < 100 && !importDisabled; i++) {
		await deleteSettings.waitForTimeout(100);
		importDisabled = await deleteSettings.evaluate(() => {
			const buttons = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent === "Import");
			return buttons.length === 1 && buttons[0]!.disabled;
		});
	}
	await page.screenshot({ path: join(out, "06-after-delete.png") });
	expect("after deleting local data the Import button waits for the plugin restart", importDisabled, importDisabled);
	await session.close();

	const unexpected = consoleErrors.filter((e) => !e.includes("ERR_PROXY_CONNECTION_FAILED"));
	step("console errors", consoleErrors);
	expect("no console errors except the blocked network", unexpected.length === 0, unexpected);
} finally {
	await session?.close();
}
expect("your Obsidian untouched", JSON.stringify(guardBefore) === JSON.stringify(await userGuard(live)));
await finish(join(out, "report.json"));
