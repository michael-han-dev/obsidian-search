import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { E5_SMALL_V2 } from "../../src/core/encoder-spec.ts";
import { importModel } from "../../src/plugin/model-files.ts";
import { EVERYDAY_NOTES, EVERYDAY_SEARCHES } from "../../test/fixtures/everyday.ts";
import { captureConsole, launch, liveRoot, openAndWait, prepare, type Session, typeInPane, userGuard, writeNotes } from "./harness.ts";
import { createReport } from "./report.ts";

const live = liveRoot(resolve(process.argv[2] ?? "dev-assets/live-everyday"));
const out = join(live.root, "results");
const { step, expect, finish } = createReport();
const consoleErrors: string[] = [];

await mkdir(out, { recursive: true });
const guardBefore = await userGuard(live);
let session: Session | null = null;
try {
	await prepare(live, { fresh: true });
	await writeNotes(live.vault, EVERYDAY_NOTES);
	const imported = await importModel(live.modelSource, live.dataDir, E5_SMALL_V2, () => {});
	if (!imported.ok) throw new Error(imported.message);
	session = await launch(live, 9344);
	const page = session.page;
	captureConsole(page, consoleErrors);
	step("enable to ready ms", await openAndWait(session, { trust: true }));

	const outcomes: { query: string; kind: string; top: string; rows: string[] }[] = [];
	for (const c of EVERYDAY_SEARCHES) {
		const pane = await typeInPane(page, c.query, { settled: (r) => r.kind === c.kind });
		outcomes.push({ query: c.query, kind: pane.kind, top: pane.rows[0] ?? "", rows: pane.rows.slice(0, 3) });
		if (c.kind === "matching") {
			expect(`everyday ${c.query}`, pane.kind === "matching" && JSON.stringify(pane.rows) === JSON.stringify(c.files), pane.rows);
		} else {
			expect(`everyday ${c.query}`, pane.kind === "results" && pane.rows[0] === c.top && (c.absent ?? []).every((p) => !pane.rows.includes(p)), { kind: pane.kind, top3: pane.rows.slice(0, 3) });
		}
		if (c.query === "why did we postpone hiring") await page.screenshot({ path: join(out, "everyday-01-hiring.png") });
	}
	await writeFile(join(out, "everyday-searches.json"), `${JSON.stringify(outcomes, null, 1)}\n`);
	step("everyday searches checked", `${EVERYDAY_SEARCHES.length} of ${EVERYDAY_SEARCHES.length}`);

	step("console errors", consoleErrors);
	expect("no console errors", consoleErrors.length === 0, consoleErrors);
} finally {
	await session?.close();
}
expect("your Obsidian untouched", JSON.stringify(guardBefore) === JSON.stringify(await userGuard(live)));
await finish(join(out, "everyday-report.json"));
