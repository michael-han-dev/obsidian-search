import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, chromium, type Page } from "playwright-core";
import { ENCODER } from "../../src/core/encoder-spec.ts";
import { acquireModel } from "../../src/plugin/model-files.ts";

const OBSIDIAN = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const USER_OBSIDIAN = join(homedir(), "Library", "Application Support", "obsidian");
const CLI_SOCKET = join(homedir(), ".obsidian-cli.sock");
// Outranks every real release, so Obsidian's loader runs the wrapper and its updater never replaces it.
const WRAPPER_ASAR = "obsidian-999.0.0.asar";
// Covered or unfocused test windows must keep running and painting like a window in front.
const QUIET_FLAGS = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];

function asarArchive(files: Record<string, Buffer>): Buffer {
	const entries: Record<string, { size: number; offset: string }> = {};
	let offset = 0;
	for (const [name, body] of Object.entries(files)) {
		entries[name] = { size: body.length, offset: String(offset) };
		offset += body.length;
	}
	const json = Buffer.from(JSON.stringify({ files: entries }));
	const header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4);
	header.writeUInt32LE(header.length - 4, 0);
	header.writeUInt32LE(json.length, 4);
	json.copy(header, 8);
	const size = Buffer.alloc(8);
	size.writeUInt32LE(4, 0);
	size.writeUInt32LE(header.length, 4);
	return Buffer.concat([size, header, ...Object.values(files)]);
}

export interface LiveRoot {
	readonly root: string;
	readonly userData: string;
	readonly vault: string;
	readonly dataDir: string;
	readonly modelSource: string;
}

export function liveRoot(root: string): LiveRoot {
	return { root, userData: join(root, "userdata"), vault: join(root, "vault"), dataDir: join(root, "dowse-data"), modelSource: join(process.cwd(), "dev-assets", "model") };
}

export interface UserGuard {
	readonly pids: string;
	readonly configMtime: number;
	readonly cliSocket: string;
}

async function newestObsidianAsar(): Promise<string> {
	const version = (name: string) => name.slice("obsidian-".length, -".asar".length).split(".").map(Number);
	const byNewest = (a: string, b: string) => version(b).reduce((d, n, i) => d || n - version(a)[i]!, 0);
	const [newest] = (await readdir(USER_OBSIDIAN)).filter((n) => /^obsidian-\d+\.\d+\.\d+\.asar$/.test(n)).sort(byNewest);
	if (!newest) throw new Error(`No obsidian-<version>.asar in ${USER_OBSIDIAN}`);
	return join(USER_OBSIDIAN, newest);
}

export async function userGuard(live: LiveRoot): Promise<UserGuard> {
	const pids = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
		.split("\n")
		.filter((line) => line.includes("/Contents/MacOS/Obsidian") && !line.includes(live.userData))
		.map((line) => line.trim().split(" ")[0])
		.join(",");
	const socket = await stat(CLI_SOCKET).catch(() => null);
	return { pids, configMtime: (await stat(join(USER_OBSIDIAN, "obsidian.json"))).mtimeMs, cliSocket: socket ? `${socket.ino}:${socket.mtimeMs}` : "absent" };
}

export async function killStrays(live: LiveRoot): Promise<void> {
	try {
		execFileSync("pkill", ["-f", "--", `--user-data-dir=${live.userData}`]);
	} catch {
		return;
	}
	await sleep(1500);
}

export async function prepare(live: LiveRoot, { fresh, plugin: withPlugin = true }: { fresh: boolean; plugin?: boolean }): Promise<void> {
	if (fresh) for (const dir of [live.userData, live.vault, live.dataDir, join(live.root, "fixture")]) await rm(dir, { recursive: true, force: true });
	await mkdir(live.userData, { recursive: true });
	for (const name of await readdir(live.userData)) if (/^(real-)?obsidian.*\.asar$/.test(name)) await rm(join(live.userData, name), { force: true });
	await copyFile(await newestObsidianAsar(), join(live.userData, "real-obsidian.asar"));
	const files = { "main.js": await readFile("scripts/live/test-obsidian.cjs"), "package.json": Buffer.from('{"type":"commonjs"}') };
	await writeFile(join(live.userData, WRAPPER_ASAR), asarArchive(files));
	await writeFile(join(live.userData, "obsidian.json"), JSON.stringify({ vaults: { "0123456789abcdef": { path: live.vault, ts: Date.now(), open: true } } }));
	if (!withPlugin) return mkdir(join(live.vault, ".obsidian"), { recursive: true }).then(() => {});
	const plugin = join(live.vault, ".obsidian", "plugins", "dowse");
	await mkdir(plugin, { recursive: true });
	for (const name of ["main.js", "manifest.json", "styles.css"]) await copyFile(join("dist", name), join(plugin, name));
	await writeFile(join(live.vault, ".obsidian", "community-plugins.json"), JSON.stringify(["dowse"]));
}

export async function installModel(live: LiveRoot): Promise<void> {
	const result = await acquireModel({ kind: "folder", dir: live.modelSource }, live.dataDir, ENCODER, new AbortController().signal, () => {});
	if (result.kind !== "installed") throw new Error(`model install: ${JSON.stringify(result)}`);
}

export async function writeFixture(live: LiveRoot): Promise<void> {
	execFileSync("node", ["scripts/make-fixture-vault.ts", join(live.root, "fixture")], { stdio: "ignore" });
	await cp(join(live.root, "fixture"), live.vault, { recursive: true });
}

export async function writeNotes(root: string, notes: Record<string, string>): Promise<void> {
	for (const [path, text] of Object.entries(notes)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	}
}

export interface Session {
	readonly process: ChildProcess;
	readonly browser: Browser;
	readonly page: Page;
	readonly launchedAt: number;
	close(): Promise<void>;
}

export const OFFLINE_ARGS = ["--proxy-server=127.0.0.1:9", "--host-resolver-rules=MAP * ~NOTFOUND"];

export async function launch(
	live: LiveRoot,
	port: number,
	extraArgs: readonly string[] = [],
	{ scratchData = true, env = {} }: { scratchData?: boolean; env?: Record<string, string> } = {},
): Promise<Session> {
	await killStrays(live);
	const launchedAt = Date.now();
	const { DOWSE_DATA_DIR: _, DOWSE_MODEL_BASE_URL: __, DOWSE_IDLE_MS: ___, ...inherited } = process.env;
	const child = spawn(OBSIDIAN, [`--user-data-dir=${live.userData}`, `--remote-debugging-port=${port}`, ...QUIET_FLAGS, ...extraArgs], {
		env: { ...inherited, ...(scratchData ? { DOWSE_DATA_DIR: live.dataDir } : {}), ...env },
		stdio: "ignore",
	});
	let browser: Browser | null = null;
	for (let i = 0; i < 100 && !browser; i++) {
		await sleep(200);
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
	}
	if (!browser) throw new Error("Obsidian did not open its debugging port");
	let page: Page | undefined;
	for (let i = 0; i < 100 && !page; i++) {
		page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("app://obsidian.md/index.html"));
		if (!page) await sleep(200);
	}
	if (!page) throw new Error("Obsidian opened no vault window");
	await page.waitForFunction(() => (window as unknown as { app?: { workspace?: { layoutReady?: boolean } } }).app?.workspace?.layoutReady === true, null, { timeout: 30000 });
	let closing = false;
	const unexpected = (what: string) => !closing && console.error(`test Obsidian ${what} at ${new Date().toISOString()}`);
	page.on("crash", () => unexpected("renderer crashed"));
	page.on("close", () => unexpected("window closed"));
	child.on("exit", (code, signal) => unexpected(`exited with code ${code}, signal ${signal}`));
	return {
		process: child,
		browser,
		page,
		launchedAt,
		async close() {
			closing = true;
			await browser.close().catch(() => {});
			child.kill("SIGTERM");
			for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await rm(join(tmpdir(), `dowse-test-obsidian-${child.pid}.sock`), { force: true });
		},
	};
}

export function captureConsole(page: Page, into: string[] = []): string[] {
	page.on("console", (m) => {
		if (m.type() === "error") into.push(m.text());
	});
	page.on("pageerror", (e) => into.push(`pageerror: ${e.message}`));
	return into;
}

export const pluginLoaded = (page: Page) => page.waitForFunction(() => !!(window as any).app.plugins.plugins.dowse, null, { timeout: 20000 });

export const openPane = (page: Page) => page.evaluate(() => (window as any).app.commands.executeCommandById("dowse:open-search"));

export async function waitForLabel(page: Page, labels: string[], timeout = 120000): Promise<number> {
	const started = Date.now();
	await page.waitForFunction((wanted) => wanted.includes((document.querySelector(".dowse-status") as HTMLElement | null)?.dataset.label ?? ""), labels, { timeout, polling: 50 });
	return Date.now() - started;
}

export function rendererPids(live: LiveRoot): string[] {
	return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
		.split("\n")
		.filter((l) => l.includes(live.userData) && l.includes("--type=renderer"))
		.map((l) => l.trim().split(" ")[0]!);
}

export function footprint(live: LiveRoot): { footprintMb: number; peakMb: number } {
	const all: Record<string, { footprintMb: number; peakMb: number }> = JSON.parse(execFileSync("python3", ["-I", "scripts/live/footprint.py", ...rendererPids(live)], { encoding: "utf8" }));
	return Object.values(all).reduce((a, b) => ({ footprintMb: a.footprintMb + b.footprintMb, peakMb: a.peakMb + b.peakMb }), { footprintMb: 0, peakMb: 0 });
}

export async function openAndWait(session: Session, { trust = false, label = "ready", timeout = 300000 }: { trust?: boolean; label?: string; timeout?: number } = {}): Promise<number> {
	const { page } = session;
	const started = Date.now();
	if (trust) await page.getByRole("button", { name: "Trust author and enable plugins" }).click();
	await pluginLoaded(page);
	await openPane(page);
	await waitForLabel(page, [label], timeout);
	return Date.now() - started;
}

export const statusOf = (page: Page) =>
	page.evaluate(() => {
		const el = document.querySelector(".dowse-status") as HTMLElement | null;
		return { label: el?.dataset.label ?? "", text: el?.textContent ?? "" };
	});

export interface StatusSnapshot {
	model: { kind: string; message?: string; retry?: string; doneBytes?: number; totalBytes?: number };
	coverage: { embeddedSources: number; totalSources: number };
	counters: { passageInferences: number; queryInferences: number; sessionsCreated: number; sessionsLive: number; slowestPassageMs: number; passageMsHistogram: number[] };
	passageInferences: number;
}

export const engineStatus = (page: Page): Promise<StatusSnapshot> =>
	page.evaluate(() => {
		const status = (window as any).app.plugins.plugins.dowse.status;
		return { ...status, passageInferences: status.counters.passageInferences };
	});

// A background test window never gets OS focus, so Obsidian's activeWindow stays on its hidden
// Settings window, where a modal would open. A person clicking the pane has already focused it.
export async function focusMain(page: Page): Promise<void> {
	await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
}

export async function openSetup(page: Page): Promise<void> {
	await focusMain(page);
	if (await page.locator(".dowse-action").isVisible()) await page.locator(".dowse-action").click();
	else await page.evaluate(() => (window as any).app.commands.executeCommandById("dowse:set-up"));
	await page.waitForSelector(".dowse-setup .dowse-setup-state", { state: "attached", timeout: 10000 });
}

export const setupState = (page: Page): Promise<{ label: string; text: string }> =>
	page.evaluate(() => {
		const el = document.querySelector(".dowse-setup .dowse-setup-state") as HTMLElement | null;
		const line = el?.querySelector(".dowse-setup-line")?.textContent;
		return { label: el?.dataset.label ?? "", text: line ?? el?.textContent ?? "" };
	});

export async function waitForSetup(page: Page, done: (state: { label: string; text: string }) => boolean, timeout = 120000): Promise<{ label: string; text: string }> {
	const started = Date.now();
	for (;;) {
		const state = await setupState(page);
		if (done(state)) return state;
		if (Date.now() - started > timeout) throw new Error(`setup did not settle: ${JSON.stringify(state)}`);
		await page.waitForTimeout(50);
	}
}

export async function importInSetup(page: Page, folder: string): Promise<void> {
	await page.locator(".dowse-setup input[type=text]").fill(folder);
	await page.locator(".dowse-setup button", { hasText: "Import" }).click();
}

export const closeModal = (page: Page) => page.keyboard.press("Escape");

export interface Span {
	start: { line: number; column: number };
	end: { line: number; column: number };
}

export interface Found {
	kind: string;
	error?: string;
	total?: number;
	coverage?: { embeddedSources: number; totalSources: number };
	files: { path: string; revision: string; passages: { headingPath: string[]; text: string; span: Span; score: number }[] }[];
}

export const search = (page: Page, text: string, limit = 2000): Promise<Found> =>
	page.evaluate(
		async ({ text, limit }) => {
			const r = await (window as any).app.plugins.plugins.dowse.search(text, limit);
			if (!r) return { kind: "null", files: [] };
			const files = (r.files ?? []).map((f: any) => ({ path: f.path, revision: f.revision, passages: f.passages ?? (f.evidence ? [f.evidence] : []) }));
			return { kind: r.kind, error: r.error, total: r.total, coverage: r.coverage, files };
		},
		{ text, limit },
	);

export const nativeSearch = (page: Page, query: string): Promise<string[]> =>
	page.evaluate(async (q) => {
		const app = (window as any).app;
		app.internalPlugins.getPluginById("global-search").instance.openGlobalSearch(q);
		const view = app.workspace.getLeavesOfType("search")[0].view;
		const read = () => [...(view.dom.resultDomLookup?.keys() ?? [])].map((f: any) => f.path).sort();
		let last = "";
		for (let stable = 0, i = 0; stable < 4 && i < 100; i++) {
			await new Promise((r) => setTimeout(r, 100));
			const now = JSON.stringify(read());
			stable = now === last ? stable + 1 : 0;
			last = now;
		}
		return read();
	}, query);

export interface Pane {
	kind: string;
	latencyMs: number;
	embedMs: number;
	summary: string;
	summaryIsError: boolean;
	rows: string[];
}

export async function typeInPane(page: Page, text: string, { delay = 20, waitMs = 0, settled, timeout = 8000 }: { delay?: number; waitMs?: number; settled?: (pane: Pane) => boolean; timeout?: number } = {}): Promise<Pane> {
	const input = page.locator(".dowse-input");
	const previous = await page.evaluate(() => (document.querySelector(".dowse-results") as HTMLElement).dataset.generation ?? "0");
	await input.fill("");
	await input.pressSequentially(text, { delay });
	await page.waitForFunction(
		({ prev, text }) => {
			const el = document.querySelector(".dowse-results") as HTMLElement;
			return el.dataset.generation !== prev && el.dataset.query === text && el.dataset.latencyMs !== undefined;
		},
		{ prev: previous, text },
		{ timeout: 20000, polling: 10 },
	);
	await page.waitForTimeout(waitMs);
	const read = (): Promise<Pane> =>
		page.evaluate(() => {
			const el = document.querySelector(".dowse-results") as HTMLElement;
			return {
				kind: el.dataset.kind ?? "",
				latencyMs: Number(el.dataset.latencyMs),
				embedMs: Number(el.dataset.embedMs),
				summary: document.querySelector(".dowse-summary")?.textContent ?? "",
				summaryIsError: document.querySelector(".dowse-summary")?.classList.contains("dowse-error") ?? false,
				rows: Array.from(el.querySelectorAll(".dowse-result")).map((r) => (r as HTMLElement).dataset.path!),
			};
		});
	const started = Date.now();
	let pane = await read();
	while (settled && !settled(pane) && Date.now() - started < timeout) {
		await page.waitForTimeout(50);
		pane = await read();
	}
	return pane;
}
