import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { copyFile, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

export async function prepare(live: LiveRoot, { fresh }: { fresh: boolean }): Promise<void> {
	if (fresh) await rm(live.root, { recursive: true, force: true });
	await mkdir(live.userData, { recursive: true });
	await copyFile(join(USER_OBSIDIAN, "obsidian-1.14.4.asar"), join(live.userData, "obsidian-1.14.4.asar"));
	await writeFile(join(live.userData, "obsidian.json"), JSON.stringify({ vaults: { "0123456789abcdef": { path: live.vault, ts: Date.now(), open: true } } }));
	const plugin = join(live.vault, ".obsidian", "plugins", "dowse");
	await mkdir(plugin, { recursive: true });
	for (const name of ["main.js", "manifest.json", "styles.css"]) await copyFile(join("dist", name), join(plugin, name));
	await writeFile(join(live.vault, ".obsidian", "community-plugins.json"), JSON.stringify(["dowse"]));
}

export async function writeFixture(live: LiveRoot): Promise<void> {
	execFileSync("node", ["scripts/make-fixture-vault.ts", join(live.root, "fixture")], { stdio: "ignore" });
	await cp(join(live.root, "fixture"), live.vault, { recursive: true });
}

export interface Session {
	readonly process: ChildProcess;
	readonly browser: Browser;
	readonly page: Page;
	readonly launchedAt: number;
	close(): Promise<void>;
}

export const OFFLINE_ARGS = ["--proxy-server=127.0.0.1:9", "--host-resolver-rules=MAP * ~NOTFOUND"];

export async function launch(live: LiveRoot, port: number, extraArgs: readonly string[] = []): Promise<Session> {
	await killStrays(live);
	const launchedAt = Date.now();
	const child = spawn(OBSIDIAN, [`--user-data-dir=${live.userData}`, `--remote-debugging-port=${port}`, ...extraArgs], {
		env: { ...process.env, DOWSE_DATA_DIR: live.dataDir },
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
