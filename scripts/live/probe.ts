import { resolve } from "node:path";
import { launch, liveRoot, prepare, userGuard, writeFixture } from "./harness.ts";

const live = liveRoot(resolve(process.argv[2] ?? "dev-assets/live"));
const before = await userGuard(live);
await prepare(live, { fresh: true });
await writeFixture(live);
const session = await launch(live, 9339);
await session.page.waitForTimeout(1500);
await session.page.screenshot({ path: `${live.root}/probe.png` });
const info = await session.page.evaluate(() => {
	const app = (window as any).app;
	return {
		vault: app.vault.getName(),
		files: app.vault.getMarkdownFiles().length,
		pluginsEnabled: app.plugins.isEnabled?.(),
		loaded: Object.keys(app.plugins.plugins),
		modals: Array.from(document.querySelectorAll(".modal-container .modal-title, .modal-container button")).map((e) => (e as HTMLElement).innerText),
		versions: (window as any).process?.versions && { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
		appVersion: (window as any).electron?.ipcRenderer ? "ipc" : undefined,
		crossOriginIsolated: window.crossOriginIsolated,
		sab: typeof SharedArrayBuffer,
	};
});
console.log(JSON.stringify(info, null, 1));
await session.close();
const after = await userGuard(live);
console.log("user Obsidian untouched:", JSON.stringify(before) === JSON.stringify(after), before, after);
