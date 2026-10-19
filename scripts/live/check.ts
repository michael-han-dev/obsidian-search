import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Page } from "playwright-core";
import { HOSTILE_PATH, QUERIES } from "../../test/fixtures/vault.ts";
import { launch, liveRoot, OFFLINE_ARGS, prepare, type Session, userGuard, writeFixture } from "./harness.ts";

const live = liveRoot(resolve(process.argv[2] ?? "dev-assets/live"));
const out = join(live.root, "results");
const report: Record<string, unknown> = {};
const consoleErrors: string[] = [];
const step = (name: string, value: unknown) => {
	report[name] = value;
	console.log(name, JSON.stringify(value));
};

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve([join(dir, e.name)]))));
	return nested.flat();
}

const status = (page: Page) => page.evaluate(() => {
	const el = document.querySelector(".dowse-status") as HTMLElement | null;
	return el ? { label: el.dataset.label, text: el.textContent } : null;
});

async function waitForLabel(page: Page, labels: string[], timeout = 120000): Promise<number> {
	const started = Date.now();
	await page.waitForFunction((wanted) => wanted.includes((document.querySelector(".dowse-status") as HTMLElement | null)?.dataset.label ?? ""), labels, { timeout, polling: 50 });
	return Date.now() - started;
}

async function runQuery(page: Page, text: string) {
	const input = page.locator(".dowse-input");
	const previous = await page.evaluate(() => (document.querySelector(".dowse-results") as HTMLElement).dataset.generation ?? "0");
	await input.fill("");
	await input.pressSequentially(text, { delay: 20 });
	await page.waitForFunction(
		(prev) => {
			const el = document.querySelector(".dowse-results") as HTMLElement;
			return el.dataset.generation !== prev && el.dataset.latencyMs !== undefined && el.dataset.kind === "results";
		},
		previous,
		{ timeout: 20000, polling: 10 },
	);
	await page.waitForTimeout(250);
	return page.evaluate(() => {
		const el = document.querySelector(".dowse-results") as HTMLElement;
		return {
			generation: el.dataset.generation,
			latencyMs: Number(el.dataset.latencyMs),
			embedMs: Number(el.dataset.embedMs),
			paths: Array.from(el.querySelectorAll(".dowse-result")).map((r) => (r as HTMLElement).dataset.path),
		};
	});
}

const liveWorkers = new Map<string, string>();

async function attach(session: Session) {
	session.page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	session.page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
	liveWorkers.clear();
	const cdp = await session.page.context().newCDPSession(session.page);
	cdp.on("Target.attachedToTarget", (e: any) => {
		if (e.targetInfo.type === "worker") liveWorkers.set(e.sessionId, e.targetInfo.title || e.targetInfo.url.slice(0, 20));
		void cdp.send("Runtime.runIfWaitingForDebugger" as any, undefined).catch(() => {});
	});
	cdp.on("Target.detachedFromTarget", (e: any) => liveWorkers.delete(e.sessionId));
	await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
}

const openPane = (page: Page) => page.evaluate(() => (window as any).app.commands.executeCommandById("dowse:open-search"));

await mkdir(out, { recursive: true });
const guardBefore = await userGuard(live);
let session: Session | null = null;
try {
await prepare(live, { fresh: true });
await writeFixture(live);

// First launch: trust, enable, model-needed state.
session = await launch(live, 9339);
await attach(session);
let page = session.page;
await page.getByRole("button", { name: "Trust author and enable plugins" }).click();
await page.waitForFunction(() => !!(window as any).app.plugins.plugins.dowse, null, { timeout: 20000 });
step("versions", await page.evaluate(() => ({ obsidian: (window as any).require("electron").ipcRenderer.sendSync("version"), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node })));
await openPane(page);
await waitForLabel(page, ["model-needed"]);
await page.screenshot({ path: join(out, "01-model-needed.png") });
step("model-needed status", await status(page));
step("workers before import", [...liveWorkers.values()]);

// Search before the model exists: not-ready, no results.
await page.locator(".dowse-input").fill("sourdough");
await page.waitForTimeout(600);
step("search before model", await page.evaluate(() => (document.querySelector(".dowse-results") as HTMLElement).dataset.kind ?? "none"));

// Import the model through the settings window, which Obsidian 1.14 opens as its own window.
await page.evaluate(() => (window as any).app.commands.executeCommandById("app:open-settings"));
let settings: Page | undefined;
for (let i = 0; i < 50 && !settings; i++) {
	for (const candidate of session.browser.contexts().flatMap((c) => c.pages())) {
		if ((await candidate.title().catch(() => "")).startsWith("Settings")) settings = candidate;
	}
	if (!settings) await page.waitForTimeout(100);
}
if (!settings) throw new Error("Settings window did not open");
await settings.locator(".vertical-tab-nav-item", { hasText: "Dowse" }).click();
await settings.locator(".vertical-tab-content input[type=text]").fill(live.modelSource);
await settings.screenshot({ path: join(out, "02-settings.png") });
const importStarted = Date.now();
await settings.locator(".vertical-tab-content button", { hasText: "Import" }).click();
await settings.waitForFunction(() => Array.from(document.querySelectorAll(".notice")).some((n) => n.textContent?.includes("Model imported")), null, { timeout: 120000 });
step("import ms", Date.now() - importStarted);
await settings.screenshot({ path: join(out, "02b-imported.png") });
await page.evaluate(() => (window as any).app.setting.close());
const indexMs = await waitForLabel(page, ["ready"], 300000);
step("model load plus first indexing ms", indexMs);
step("ready status", await status(page));
await page.screenshot({ path: join(out, "03-ready.png") });

// Fixture queries through the real input.
const ranks = [];
for (const q of QUERIES) {
	const r = await runQuery(page, q.text);
	ranks.push({ query: q.text, rank: r.paths.indexOf(q.expectedSource) + 1, latencyMs: r.latencyMs, embedMs: r.embedMs });
}
step("fixture ranks", ranks.map((r) => `${r.rank}:${r.query}`));

// Hostile note renders as text.
await runQuery(page, "marketing newsletter html");
await page.screenshot({ path: join(out, "04-hostile.png") });
step("hostile", await page.evaluate((path) => {
	const row = document.querySelector(`.dowse-result[data-path="${CSS.escape(path)}"]`);
	return {
		shown: !!row,
		passageText: row?.querySelector(".dowse-passage")?.textContent?.slice(0, 120),
		elementsInResults: Array.from(document.querySelectorAll(".dowse-results img, .dowse-results script, .dowse-results b")).length,
		pwned: (window as any).__dowsePwned ?? null,
	};
}, HOSTILE_PATH));

// Keyboard open lands on the passage.
await runQuery(page, "who to call when the main database goes down");
await page.locator(".dowse-input").press("Enter");
await page.waitForTimeout(800);
step("opened", await page.evaluate(() => {
	const app = (window as any).app;
	return { path: app.workspace.getActiveFile()?.path, cursorLine: app.workspace.activeEditor?.editor?.getCursor().line + 1 };
}));
await page.screenshot({ path: join(out, "05-opened.png") });

// Storage: nothing in the vault, index and model in the data folder.
await page.waitForTimeout(3000);
step("vault files that are not notes or Obsidian config", (await walk(live.vault)).map((f) => relative(live.vault, f)).filter((f) => !f.endsWith(".md") && !f.startsWith(".obsidian/")));
step("dowse plugin folder", (await walk(join(live.vault, ".obsidian", "plugins", "dowse"))).map((f) => relative(live.vault, f)));
step("data folder", (await walk(live.dataDir)).map((f) => relative(live.dataDir, f).replace(/vectors-[\w-]+/, "vectors-<id>")));
await session.close();

// Restart: index restores, search works without re-indexing.
session = await launch(live, 9339);
await attach(session);
page = session.page;
await page.waitForFunction(() => !!(window as any).app.plugins.plugins.dowse, null, { timeout: 20000 });
await openPane(page);
step("restart to ready ms", await waitForLabel(page, ["ready"], 120000));
step("search after restart", (await runQuery(page, "avoid charging a customer twice")).paths.slice(0, 2));

// Entry points: the command focuses the search box, and a hotkey the user assigns runs it from the editor.
await page.evaluate(() => (window as any).app.workspace.getLeaf(false).openFile((window as any).app.vault.getAbstractFileByPath("Cooking/Pizza dough.md")));
await page.waitForTimeout(300);
await openPane(page);
step("command focuses input", await page.evaluate(() => document.activeElement?.classList.contains("dowse-input") ?? false));
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
step("assigned hotkey", { focusedBefore, focusedAfter: await page.evaluate(() => document.activeElement?.classList.contains("dowse-input") ?? false) });

// Plugin update: new release files with a higher version keep the index.
const indexBefore = (await walk(live.dataDir)).filter((f) => f.endsWith(".f32")).map((f) => relative(live.dataDir, f));
const pluginDir = join(live.vault, ".obsidian", "plugins", "dowse");
await page.evaluate(() => (window as any).app.plugins.disablePlugin("dowse"));
const manifest = JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8"));
await writeFile(join(pluginDir, "manifest.json"), JSON.stringify({ ...manifest, version: "0.0.2" }));
await writeFile(join(pluginDir, "main.js"), (await readFile(join(pluginDir, "main.js"), "utf8")) + "\n// update marker\n");
await page.evaluate(async () => {
	await (window as any).app.plugins.loadManifests();
	await (window as any).app.plugins.enablePlugin("dowse");
});
await openPane(page);
step("after update to ready ms", await waitForLabel(page, ["ready"], 120000));
step("after update", {
	version: await page.evaluate(() => (window as any).app.plugins.manifests.dowse.version),
	sameVectorsFile: JSON.stringify((await walk(live.dataDir)).filter((f) => f.endsWith(".f32")).map((f) => relative(live.dataDir, f))) === JSON.stringify(indexBefore),
	search: (await runQuery(page, "why are my plant leaves going yellow")).paths.slice(0, 1),
});

// Disable and re-enable.
step("workers before disable", [...liveWorkers.values()]);
await page.evaluate(() => (window as any).app.plugins.disablePlugin("dowse"));
await page.waitForTimeout(2500);
step("after disable", { plugin: await page.evaluate(() => !!(window as any).app.plugins.plugins.dowse), workers: [...liveWorkers.values()] });
const vectorsAfterDisable = (await walk(live.dataDir)).filter((f) => f.endsWith(".f32"));
const errorsBefore = consoleErrors.length;
await page.evaluate(async () => {
	await (window as any).app.vault.create("Inbox/Written while disabled.md", "# Written while disabled\n\nThis note appears while Dowse is off.");
});
await page.waitForTimeout(3000);
step("edit while disabled", {
	newErrors: consoleErrors.slice(errorsBefore),
	indexUntouched: JSON.stringify((await walk(live.dataDir)).filter((f) => f.endsWith(".f32"))) === JSON.stringify(vectorsAfterDisable),
	workers: [...liveWorkers.values()].filter((w) => w === "dowse-engine").length,
});
await page.evaluate(() => (window as any).app.plugins.enablePlugin("dowse"));
await page.waitForFunction(() => !!(window as any).app.plugins.plugins.dowse, null, { timeout: 20000 });
await openPane(page);
step("re-enable to ready ms", await waitForLabel(page, ["ready"], 120000));
step("search after re-enable", (await runQuery(page, "tips for falling asleep faster")).paths.slice(0, 1));
step("note created while disabled is indexed on re-enable", (await runQuery(page, "a note that appears while the plugin is off")).paths.slice(0, 1));
await session.close();

// Offline: every network request fails, search still works.
session = await launch(live, 9339, OFFLINE_ARGS);
await attach(session);
page = session.page;
step("network blocked", await page.evaluate(() => fetch("https://example.com").then(() => "reachable", () => "blocked")));
await page.waitForFunction(() => !!(window as any).app.plugins.plugins.dowse, null, { timeout: 20000 });
await openPane(page);
step("offline to ready ms", await waitForLabel(page, ["ready"], 120000));
step("offline search", (await runQuery(page, "things to see in Tokyo")).paths.slice(0, 1));
await session.close();

step("console errors", consoleErrors);
} finally {
	await session?.close();
}
const guardAfter = await userGuard(live);
step("user Obsidian untouched", JSON.stringify(guardBefore) === JSON.stringify(guardAfter));
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 1));
