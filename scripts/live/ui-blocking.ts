import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { launch, liveRoot, type Session } from "./harness.ts";

const live = liveRoot(resolve(process.argv[2] ?? "dev-assets/live"));
const runs = Number(process.argv[3] ?? 5);
const results: { enableMs: number; readyMs: number; longTasks: number; longTaskTotalMs: number; longestTaskMs: number }[] = [];
let session: Session | null = null;
try {
	session = await launch(live, 9339);
	const page = session.page;
	await page.waitForFunction(() => !!(window as any).app.plugins.plugins.dowse, null, { timeout: 20000 });
	await page.evaluate(() => (window as any).app.commands.executeCommandById("dowse:open-search"));
	for (let i = 0; i < runs; i++) {
		await page.evaluate(() => (window as any).app.plugins.disablePlugin("dowse"));
		await page.waitForTimeout(1000);
		results.push(
			await page.evaluate(async () => {
				const tasks: number[] = [];
				const observer = new PerformanceObserver((list) => list.getEntries().forEach((e) => tasks.push(e.duration)));
				observer.observe({ type: "longtask", buffered: false });
				const started = performance.now();
				await (window as any).app.plugins.enablePlugin("dowse");
				const enableMs = performance.now() - started;
				await (window as any).app.commands.executeCommandById("dowse:open-search");
				while ((document.querySelector(".dowse-status") as HTMLElement | null)?.dataset.label !== "ready") await new Promise((r) => setTimeout(r, 10));
				const readyMs = performance.now() - started;
				await new Promise((r) => setTimeout(r, 300));
				observer.disconnect();
				return { enableMs, readyMs, longTasks: tasks.length, longTaskTotalMs: tasks.reduce((a, b) => a + b, 0), longestTaskMs: Math.max(0, ...tasks) };
			}),
		);
	}
} finally {
	await session?.close();
}
console.log(JSON.stringify(results));
await writeFile(join(live.root, "results", "ui-blocking.json"), JSON.stringify(results, null, 1));
