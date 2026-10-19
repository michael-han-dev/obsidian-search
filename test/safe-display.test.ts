import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const HTML_SINKS = /\b(innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|DOMParser|document\.write|srcdoc|sanitizeHTMLToDom)\b/;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
	});
}

test("no source file passes text to an HTML parsing API", () => {
	const files = sourceFiles("src");
	const offenders = files.flatMap((file) =>
		readFileSync(file, "utf8")
			.split("\n")
			.flatMap((line, i) => (HTML_SINKS.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
	);
	assert.deepEqual(offenders, []);
	assert.ok(files.includes("src/plugin/view.ts"));
	assert.ok(HTML_SINKS.test("el.innerHTML = text"));
});
