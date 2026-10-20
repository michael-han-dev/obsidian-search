import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { copyFile, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, chromium, type Page } from "playwright-core";

const OBSIDIAN = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const USER_OBSIDIAN = join(homedir(), "Library", "Application Support", "obsidian");

export interface LiveRoot {
	readonly root: string;
	readonly userData: string;
	readonly vault: string;
	readonly dataDir: string;
	readonly modelSource: string;
}

export function liveRoot(root: string): LiveRoot {
	return { root, userData: join(root, "userdata"), vault: join(root, "vault"), dataDir: join(root, "dowse-data"), modelSource: join(process.cwd(), "dev-assets", "e5-small-v2") };
}

export interface UserGuard {
	readonly pids: string;
	readonly configMtime: number;
}

export async function userGuard(live: LiveRoot): Promise<UserGuard> {
	const pids = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
		.split("\n")
		.filter((line) => line.includes("/Contents/MacOS/Obsidian") && !line.includes(live.userData))
		.map((line) => line.trim().split(" ")[0])
		.join(",");
	return { pids, configMtime: (await stat(join(USER_OBSIDIAN, "obsidian.json"))).mtimeMs };
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
	await copyFile(join(USER_OBSIDIAN, "obsidian-1.14.4.asar"), join(live.userData, "obsidian-1.14.4.asar"));
	await writeFile(join(live.userData, "obsidian.json"), JSON.stringify({ vaults: { "0123456789abcdef": { path: live.vault, ts: Date.now(), open: true } } }));
	if (!withPlugin) return mkdir(join(live.vault, ".obsidian"), { recursive: true }).then(() => {});
	const plugin = join(live.vault, ".obsidian", "plugins", "dowse");
	await mkdir(plugin, { recursive: true });
	for (const name of ["main.js", "manifest.json", "styles.css"]) await copyFile(join("dist", name), join(plugin, name));
	await writeFile(join(live.vault, ".obsidian", "community-plugins.json"), JSON.stringify(["dowse"]));
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

export async function launch(live: LiveRoot, port: number, extraArgs: readonly string[] = [], { scratchData = true }: { scratchData?: boolean } = {}): Promise<Session> {
	await killStrays(live);
	const launchedAt = Date.now();
	const { DOWSE_DATA_DIR: _, ...inherited } = process.env;
	const child = spawn(OBSIDIAN, [`--user-data-dir=${live.userData}`, `--remote-debugging-port=${port}`, ...extraArgs], {
		env: scratchData ? { ...inherited, DOWSE_DATA_DIR: live.dataDir } : inherited,
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
	return {
		process: child,
		browser,
		page,
		launchedAt,
		async close() {
			await browser.close().catch(() => {});
			child.kill("SIGTERM");
			for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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

export const engineStatus = (page: Page): Promise<{ model: { kind: string }; coverage: { embeddedSources: number; totalSources: number }; passageInferences: number }> =>
	page.evaluate(() => (window as any).app.plugins.plugins.dowse.status);

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
