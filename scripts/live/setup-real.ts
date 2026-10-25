// Fresh install against the real model host. Needs the network; not part of npm test.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ENCODER } from "../../src/core/encoder-spec.ts";
import { PARAPHRASE_NOTES } from "../../test/fixtures/paraphrase.ts";
import { captureConsole, closeModal, launch, liveRoot, openPane, openSetup, pluginLoaded, prepare, type Session, setupState, typeInPane, userGuard, waitForLabel, waitForSetup, writeNotes } from "./harness.ts";
import { createReport, walk } from "./report.ts";

const live = liveRoot(resolve(process.argv[2] ?? "dev-assets/live-real"));
const out = join(live.root, "results");
const { step, expect, finish } = createReport();
const consoleErrors: string[] = [];

const guardBefore = await userGuard(live);
let session: Session | null = null;
try {
	await prepare(live, { fresh: true });
	await writeNotes(live.vault, PARAPHRASE_NOTES);
	session = await launch(live, 9347);
	const page = session.page;
	captureConsole(page, consoleErrors);
	step("model base url override", await page.evaluate(() => (window as any).process?.env?.DOWSE_MODEL_BASE_URL ?? null));
	await page.getByRole("button", { name: "Trust author and enable plugins" }).click();
	await pluginLoaded(page);
	await openPane(page);
	await waitForLabel(page, ["model-needed"]);
	await openSetup(page);
	await page.screenshot({ path: join(out, "real-01-setup.png") });
	const started = Date.now();
	await page.locator(".dowse-setup button", { hasText: "Download and set up" }).click();
	const samples: { ms: number; label: string; text: string }[] = [];
	for (;;) {
		const s = await setupState(page);
		samples.push({ ms: Date.now() - started, ...s });
		if (s.label !== "acquiring" && s.label !== "model-needed" && samples.length > 2) break;
		if (Date.now() - started > 15 * 60_000) throw new Error(`setup stalled: ${JSON.stringify(s)}`);
		if (samples.length === 20) await page.screenshot({ path: join(out, "real-02-progress.png") });
		await page.waitForTimeout(500);
	}
	const acquiredMs = Date.now() - started;
	const settled = await waitForSetup(page, (s) => s.label === "indexing" || s.label === "ready" || s.label === "failed", 300000);
	step("acquisition", { acquiredMs, settled, progressSamples: samples.filter((_, i) => i % 10 === 0) });
	expect("the real setup downloads, verifies, and loads the model", settled.label === "indexing" || settled.label === "ready", settled);
	await closeModal(page);
	await waitForLabel(page, ["ready"], 300000);
	step("setup click to ready ms", Date.now() - started);
	const files = (await walk(live.dataDir)).map((f) => relative(live.dataDir, f)).filter((f) => f.startsWith("models/")).sort();
	const digests: Record<string, string> = {};
	for (const f of files) digests[f] = createHash("sha256").update(await readFile(join(live.dataDir, f))).digest("hex");
	step("installed files", digests);
	expect(
		"the installed files are exactly the pinned files with their published checksums",
		JSON.stringify(Object.values(digests).sort()) === JSON.stringify([ENCODER.model.sha256, ENCODER.vocab.sha256].sort()) && files.length === 2,
		digests,
	);
	const pane = await typeInPane(page, "deadline to cancel the supplier agreement before it rolls over", { waitMs: 200 });
	await page.screenshot({ path: join(out, "real-03-first-search.png") });
	expect("the first search after the real setup finds the paraphrase", pane.rows[0] === "Daily/2026-09-02.md", pane.rows.slice(0, 3));
	step("console errors", consoleErrors);
	expect("no console errors", consoleErrors.length === 0, consoleErrors);
} finally {
	await session?.close();
}
expect("your Obsidian untouched", JSON.stringify(guardBefore) === JSON.stringify(await userGuard(live)));
await finish(join(out, "setup-real.json"));
