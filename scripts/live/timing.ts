import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "playwright-core";
import { QUERIES } from "../../test/fixtures/vault.ts";
import { launch, liveRoot, type Session } from "./harness.ts";

const live = liveRoot(resolve(process.argv[2] ?? "dev-assets/live"));
const rounds = Number(process.argv[3] ?? 5);
const startupRuns = Number(process.argv[4] ?? 5);

const quantile = (values: number[], q: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
};
const summary = (values: number[]) => ({ n: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95), p99: quantile(values, 0.99), max: Math.max(...values) });

async function typeQuery(page: Page, text: string) {
	const input = page.locator(".dowse-input");
	const previous = await page.evaluate(() => (document.querySelector(".dowse-results") as HTMLElement).dataset.generation ?? "0");
	await input.fill("");
	await input.pressSequentially(text, { delay: 40 });
	await page.waitForFunction(
		(prev) => {
			const el = document.querySelector(".dowse-results") as HTMLElement;
			return el.dataset.generation !== prev && el.dataset.latencyMs !== undefined && el.dataset.kind === "results";
		},
		previous,
		{ timeout: 20000, polling: 10 },
	);
	await page.waitForTimeout(120);
	return page.evaluate(() => {
		const el = document.querySelector(".dowse-results") as HTMLElement;
		return { latencyMs: Number(el.dataset.latencyMs), embedMs: Number(el.dataset.embedMs) };
	});
}

const report: Record<string, unknown> = {};
let session: Session | null = null;
try {
	session = await launch(live, 9339);
	const page = session.page;
	await page.waitForFunction(() => !!(window as any).app.plugins.plugins.dowse, null, { timeout: 20000 });
	await page.evaluate(() => (window as any).app.commands.executeCommandById("dowse:open-search"));
	await page.waitForFunction(() => (document.querySelector(".dowse-status") as HTMLElement | null)?.dataset.label === "ready", null, { timeout: 60000 });
	await typeQuery(page, "warm up the model");
	const latency: number[] = [];
	const embed: number[] = [];
	for (let r = 0; r < rounds; r++) {
		for (const q of QUERIES) {
			const t = await typeQuery(page, q.text);
			latency.push(t.latencyMs);
			embed.push(t.embedMs);
		}
	}
	report.keystrokeToResultsMs = summary(latency);
	report.queryEmbedMs = summary(embed);
	report.pauseMs = 150;

	const enableMs: number[] = [];
	for (let i = 0; i < 10; i++) {
		await page.evaluate(() => (window as any).app.plugins.disablePlugin("dowse"));
		await page.waitForTimeout(300);
		enableMs.push(await page.evaluate(async () => {
			const t = performance.now();
			await (window as any).app.plugins.enablePlugin("dowse");
			return performance.now() - t;
		}));
		await page.waitForTimeout(300);
	}
	report.enablePluginMs = summary(enableMs);
	await session.close();
	session = null;

	const startup: Record<string, number[]> = { enabled: [], disabled: [] };
	for (let i = 0; i < startupRuns; i++) {
		for (const mode of ["enabled", "disabled"] as const) {
			await writeFile(join(live.vault, ".obsidian", "community-plugins.json"), JSON.stringify(mode === "enabled" ? ["dowse"] : []));
			const s = await launch(live, 9339);
			startup[mode]!.push(Date.now() - s.launchedAt);
			await s.close();
		}
	}
	await writeFile(join(live.vault, ".obsidian", "community-plugins.json"), JSON.stringify(["dowse"]));
	report.launchToLayoutReadyMs = { enabled: summary(startup.enabled!), disabled: summary(startup.disabled!) };
} finally {
	await session?.close();
}
console.log(JSON.stringify(report, null, 1));
await writeFile(join(live.root, "results", "timing.json"), JSON.stringify(report, null, 1));
