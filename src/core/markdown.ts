import { digest } from "./hash.ts";
import type { MarkdownBlock, SourceDocument, SourceFile, SourceId, TextSpan } from "./types.ts";

export const MARKDOWN_ADAPTER_VERSION = "obsidian-markdown@4";

export const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/);

export function textInSpan(lines: readonly string[], { start, end }: TextSpan): string {
	if (start.line === end.line) return lines[start.line - 1]!.slice(start.column, end.column);
	return [lines[start.line - 1]!.slice(start.column), ...lines.slice(start.line, end.line - 1), lines[end.line - 1]!.slice(0, end.column)].join("\n");
}
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BLANK = /^[ \t]*$/;

function frontmatterEnd(lines: readonly string[]): number {
	if (lines[0]?.trimEnd() !== "---") return 0;
	for (let i = 1; i < lines.length; i++) if (lines[i]!.trimEnd() === "---") return i + 1;
	return 0;
}

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
	const lines = splitLines(text);
	const headings: (string | undefined)[] = [];
	const blocks: MarkdownBlock[] = [];
	let paragraphStart = -1;

	const push = (first: number, last: number): void => {
		blocks.push({
			headingPath: headings.filter((h): h is string => h !== undefined),
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
		revision: await digest(file.text),
		metadata: file.metadata,
		text: file.text,
		blocks: parseMarkdownBlocks(file.text),
	};
}
