import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROPERTY_SAMPLES, TAG_NOTES, TAG_QUERIES } from "../../test/fixtures/tags.ts";
import { launch, liveRoot, nativeSearch, prepare, type Session, userGuard, writeNotes } from "./harness.ts";

const live = liveRoot(resolve(process.argv[2] ?? "dev-assets/probe"));
const out = resolve(process.argv[3] ?? "dev-assets/native-tags.json");
const before = await userGuard(live);
let session: Session | null = null;
let result: unknown;
try {
	await prepare(live, { fresh: true, plugin: false });
	await writeNotes(live.vault, TAG_NOTES);
	const probePlugin = join(live.vault, ".obsidian", "plugins", "api-probe");
	await mkdir(probePlugin, { recursive: true });
	await writeFile(join(probePlugin, "manifest.json"), JSON.stringify({ id: "api-probe", name: "API probe", version: "0.0.1", minAppVersion: "1.0.0", description: "Exposes the API module to the probe.", author: "probe", isDesktopOnly: true }));
	await writeFile(join(probePlugin, "main.js"), 'const o = require("obsidian"); module.exports = class extends o.Plugin { onload() { window.__obsidian = o; } };');
	await writeFile(join(live.vault, ".obsidian", "community-plugins.json"), JSON.stringify(["api-probe"]));
	session = await launch(live, 9341);
	const page = session.page;
	await page.getByRole("button", { name: "Trust author and enable plugins" }).click();
	await page.waitForFunction(() => !!(window as any).__obsidian, null, { timeout: 20000 });
	await page.waitForFunction((n) => (window as any).app.vault.getMarkdownFiles().length === n, Object.keys(TAG_NOTES).length, { timeout: 30000 });
	await page.waitForFunction(() => (window as any).app.metadataCache.resolved !== false, null, { timeout: 30000 });
	await page.waitForTimeout(1500);

	const obsidian = await page.evaluate((samples) => {
		const app = (window as any).app;
		const o = (window as any).__obsidian;
		const tagsByNote: Record<string, string[] | null> = {};
		const frontmatterByNote: Record<string, unknown> = {};
		const linksByNote: Record<string, unknown> = {};
		for (const file of app.vault.getMarkdownFiles()) {
			const cache = app.metadataCache.getFileCache(file);
			tagsByNote[file.path] = cache ? o.getAllTags(cache) : null;
			if (cache?.frontmatter) frontmatterByNote[file.path] = cache.frontmatter;
			if (cache?.links) linksByNote[file.path] = cache.links.map((l: any) => l.link);
		}
		const yaml: Record<string, unknown> = {};
		for (const [name, text] of Object.entries(samples as Record<string, string>)) {
			const parsed = o.parseYaml(text);
			yaml[name] = {
				parsed,
				types: Object.fromEntries(Object.entries(parsed ?? {}).map(([k, v]) => [k, v === null ? "null" : Array.isArray(v) ? "array" : v instanceof Date ? "date" : typeof v])),
				tags: o.parseFrontMatterTags(parsed),
				aliases: o.parseFrontMatterAliases(parsed),
			};
		}
		return { tagsByNote, frontmatterByNote, linksByNote, yaml };
	}, PROPERTY_SAMPLES);

	const native: Record<string, string[]> = {};
	for (const query of TAG_QUERIES) {
		native[query] = await nativeSearch(page, query);
		console.log(query, native[query]!.length);
	}
	result = { obsidian: await page.evaluate(() => (window as any).require("electron").ipcRenderer.sendSync("version")), ...obsidian, native };
} finally {
	await session?.close();
}
const after = await userGuard(live);
await writeFile(out, `${JSON.stringify(result, null, 1)}\n`);
console.log(`wrote ${out}`);
console.log("user Obsidian untouched:", JSON.stringify(before) === JSON.stringify(after));
