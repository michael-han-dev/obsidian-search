import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { installModel, killStrays, liveRoot, prepare, writeFixture } from "./harness.ts";

// Usage: npm run try [-- --setup] [root]. With --setup the model is not preinstalled, so the setup screen shows.
const args = process.argv.slice(2);
const setup = args.includes("--setup");
const live = liveRoot(resolve(args.find((a) => !a.startsWith("--")) ?? "dev-assets/try"));
await killStrays(live);
await prepare(live, { fresh: true });
await writeFixture(live);
if (!setup) await installModel(live);
const child = spawn("/Applications/Obsidian.app/Contents/MacOS/Obsidian", [`--user-data-dir=${live.userData}`], {
	env: { ...process.env, DOWSE_DATA_DIR: live.dataDir, DOWSE_TEST_WINDOWS: "visible" },
	stdio: "ignore",
	detached: true,
});
child.unref();
console.log(`Opened a separate Obsidian on the fixture vault in ${live.vault}.`);
console.log("Click 'Trust author and enable plugins', then the telescope icon in the left ribbon.");
if (setup) console.log("Then choose 'Set up concept search' in the pane. The model downloads from huggingface.co.");
console.log(`Quit that window with Cmd+Q when done. Its data lives in ${live.root}.`);
