import { resolve } from "node:path";
import { launch, liveRoot } from "./harness.ts";

const live = liveRoot(resolve(process.argv[2] ?? "dev-assets/live"));
const session = await launch(live, 9339);
try {
	console.log(JSON.stringify(await session.page.evaluate(async () => {
		const tasks: number[] = [];
		const observer = new PerformanceObserver((list) => list.getEntries().forEach((e) => tasks.push(Math.round(e.duration))));
		observer.observe({ type: "longtask", buffered: false });
		await new Promise((r) => setTimeout(r, 50));
		setTimeout(() => {
			const t = performance.now();
			while (performance.now() - t < 120);
		}, 0);
		await new Promise((r) => setTimeout(r, 400));
		observer.disconnect();
		return { supported: PerformanceObserver.supportedEntryTypes.includes("longtask"), tasks };
	})));
} finally {
	await session.close();
}
