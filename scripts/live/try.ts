import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { E5_SMALL_V2 } from "../../src/core/encoder-spec.ts";
import { importModel } from "../../src/plugin/model-files.ts";
import { killStrays, liveRoot, prepare, writeFixture } from "./harness.ts";

const live = liveRoot(resolve(process.argv[2] ?? "dev-assets/try"));
await killStrays(live);
await prepare(live, { fresh: true });
await writeFixture(live);
const imported = await importModel(live.modelSource, live.dataDir, E5_SMALL_V2, () => {});
if (!imported.ok) throw new Error(imported.message);
const child = spawn("/Applications/Obsidian.app/Contents/MacOS/Obsidian", [`--user-data-dir=${live.userData}`], {
	env: { ...process.env, DOWSE_DATA_DIR: live.dataDir },
	stdio: "ignore",
	detached: true,
});
child.unref();
console.log(`Opened a separate Obsidian on the fixture vault in ${live.vault}.`);
console.log("Click 'Trust author and enable plugins', then the telescope icon in the left ribbon.");
console.log(`Quit that window with Cmd+Q when done. Its data lives in ${live.root}.`);
