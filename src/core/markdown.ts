import { digest } from "./hash.ts";
import type { MarkdownBlock, SourceDocument, SourceFile, SourceId } from "./types.ts";

export const MARKDOWN_ADAPTER_VERSION = "obsidian-markdown@1";

const LINE_BREAK = /\r\n|\r|\n/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BLANK = /^[ \t]*$/;

function frontmatterEnd(lines: readonly string[]): number {
	if (lines[0]?.trimEnd() !== "---") return 0;
	for (let i = 1; i < lines.length; i++) if (lines[i]!.trimEnd() === "---") return i + 1;
	return 0;
}

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
	const lines = text.split(LINE_BREAK);
	const headings: (string | undefined)[] = [];
	const blocks: MarkdownBlock[] = [];
	let paragraphStart = -1;

	const push = (first: number, last: number): void => {
		blocks.push({
			headingPath: headings.filter((h): h is string => h !== undefined),
			text: lines.slice(first, last + 1).join("\n"),
			span: { start: { line: first + 1, column: 0 }, end: { line: last + 1, column: lines[last]!.length } },
		});
	};
	const flush = (before: number): void => {
		if (paragraphStart >= 0) push(paragraphStart, before - 1);
		paragraphStart = -1;
	};

	for (let i = frontmatterEnd(lines); i < lines.length; i++) {
		const line = lines[i]!;
		const fence = FENCE.exec(line);
		if (fence) {
			flush(i);
			const marker = fence[1]!;
			let close = i + 1;
			while (close < lines.length && !lines[close]!.trimStart().startsWith(marker[0]!.repeat(marker.length))) close++;
			const last = Math.min(close, lines.length - 1);
			push(i, last);
			i = last;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			flush(i);
			const level = heading[1]!.length;
			headings.length = level;
			headings[level - 1] = (heading[2] ?? "").trim();
			continue;
		}
		if (BLANK.test(line)) {
			flush(i);
			continue;
		}
		if (paragraphStart < 0) paragraphStart = i;
	}
	flush(lines.length);
	return blocks;
}

export function titleFromPath(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

export async function extractDocument(file: SourceFile): Promise<SourceDocument> {
	return {
		collectionId: file.collectionId,
		sourceId: file.path as SourceId,
		path: file.path,
		title: titleFromPath(file.path),
		aliases: file.aliases,
		revision: await digest(file.text),
		adapterVersion: MARKDOWN_ADAPTER_VERSION,
		blocks: parseMarkdownBlocks(file.text),
	};
}
