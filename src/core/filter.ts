import { splitLines, textInSpan } from "./markdown.ts";
import { normalizeForMatch } from "./metadata.ts";
import { compareCodePoints } from "./search.ts";
import type { BlockEvidence, Constraint, MatchedFile, PropertyLiteral, PropertyValue, SourceDocument, Test } from "./types.ts";

const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;

function isWordCharAt(text: string, at: number): boolean {
	if (at < 0 || at >= text.length) return false;
	const unit = text.charCodeAt(at);
	const start = unit >= 0xdc00 && unit <= 0xdfff && at > 0 ? at - 1 : at;
	return WORD_CHAR.test(String.fromCodePoint(text.codePointAt(start)!));
}

function hasPhrase(text: string, phrase: string): boolean {
	for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
		if (!isWordCharAt(text, at - 1) && !isWordCharAt(text, at + phrase.length)) return true;
	}
	return false;
}

const equalsLiteral = (value: PropertyValue, literal: PropertyLiteral): boolean =>
	Array.isArray(value) ? value.some((v) => equalsLiteral(v, literal)) : typeof value === "string" && typeof literal === "string" ? normalizeForMatch(value) === literal : value === literal;

interface Lowered {
	readonly name: string;
	readonly text: string;
}

function passes(test: Test, doc: SourceDocument, lowered: () => Lowered): boolean {
	switch (test.kind) {
		case "file":
			return normalizeForMatch(doc.path.slice(doc.path.lastIndexOf("/") + 1)).includes(test.text);
		case "path":
			return normalizeForMatch(doc.path).includes(test.text);
		case "tag":
			return doc.metadata.tags.some((t) => t === test.tag || t.startsWith(`${test.tag}/`));
		case "property":
			return Object.entries(doc.metadata.properties).some(([key, value]) => normalizeForMatch(key) === test.key && equalsLiteral(value, test.value));
		case "text": {
			const { name, text } = lowered();
			return name.includes(test.text) || hasPhrase(text, test.text);
		}
		case "word": {
			const { name, text } = lowered();
			return name.includes(test.word) || text.includes(test.word);
		}
		default: {
			const unhandled: never = test;
			return unhandled;
		}
	}
}

function evidenceFor(doc: SourceDocument, phrase: string): BlockEvidence | null {
	const lines = splitLines(doc.text);
	for (const block of doc.blocks) {
		const text = textInSpan(lines, block.span);
		if (hasPhrase(normalizeForMatch(text), phrase)) return { headingPath: block.headingPath, text, span: block.span };
	}
	return null;
}

const COST: Record<Test["kind"], number> = { file: 0, path: 0, tag: 0, property: 0, text: 1, word: 1 };

export type DocFilter = (doc: SourceDocument) => boolean;

export function compileFilter(constraints: readonly Constraint[]): DocFilter {
	const ordered = [...constraints].sort((a, b) => COST[a.test.kind] - COST[b.test.kind]);
	return (doc) => {
		let lowered: Lowered | null = null;
		const lower = () => (lowered ??= { name: normalizeForMatch(doc.path.slice(doc.path.lastIndexOf("/") + 1)), text: normalizeForMatch(doc.text) });
		return ordered.every((c) => passes(c.test, doc, lower) !== c.negated);
	};
}

export function matchingFiles(docs: Iterable<SourceDocument>, constraints: readonly Constraint[], limit: number): { files: MatchedFile[]; total: number } {
	const filter = compileFilter(constraints);
	const literal = constraints.find((c) => !c.negated && c.test.kind === "text")?.test;
	const matched = [...docs].filter(filter);
	const key = (doc: SourceDocument) => normalizeForMatch(doc.title);
	matched.sort((a, b) => compareCodePoints(key(a), key(b)) || compareCodePoints(a.path, b.path) || compareCodePoints(a.sourceId, b.sourceId));
	return {
		total: matched.length,
		files: matched.slice(0, limit).map((doc) => ({
			sourceId: doc.sourceId,
			path: doc.path,
			title: doc.title,
			revision: doc.revision,
			evidence: literal?.kind === "text" ? evidenceFor(doc, literal.text) : null,
		})),
	};
}
