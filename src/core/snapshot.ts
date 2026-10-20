import { splitLines } from "./markdown.ts";
import { toPropertyValue } from "./metadata.ts";
import type { IndexedSource } from "./search.ts";
import type { CollectionId, Digest, MarkdownBlock, NoteMetadata, Passage, PassageId, PropertyValue, SourceDocument, SourceId, TextSpan } from "./types.ts";

export interface IndexSnapshot {
	readonly fingerprint: Digest;
	readonly extraction: string;
	readonly sources: readonly IndexedSource[];
}

export interface EncodedSnapshot {
	readonly meta: string;
	readonly vectors: Float32Array;
}

const VERSION = 3;

export function encodeSnapshot(snapshot: IndexSnapshot): EncodedSnapshot {
	const total = snapshot.sources.reduce((n, s) => n + s.vectors.length, 0);
	const vectors = new Float32Array(total);
	let offset = 0;
	const sources = snapshot.sources.map((s) => {
		vectors.set(s.vectors, offset);
		offset += s.vectors.length;
		return { doc: s.doc, passages: s.passages };
	});
	return { meta: JSON.stringify({ version: VERSION, fingerprint: snapshot.fingerprint, extraction: snapshot.extraction, sources }), vectors };
}

type Json = Record<string, unknown> | null | undefined;

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function parseSpan(v: unknown): TextSpan | null {
	const s = v as { start?: Json; end?: Json } | null;
	const { start, end } = s ?? {};
	if (!start || !end || !isNumber(start.line) || !isNumber(start.column) || !isNumber(end.line) || !isNumber(end.column)) return null;
	return { start: { line: start.line, column: start.column }, end: { line: end.line, column: end.column } };
}

function parseMetadata(v: unknown): NoteMetadata | null {
	const m = v as Json;
	if (!m || !isStrings(m.aliases) || !isStrings(m.tags)) return null;
	if (!m.properties || typeof m.properties !== "object" || Array.isArray(m.properties)) return null;
	const properties: Record<string, PropertyValue> = {};
	for (const [key, value] of Object.entries(m.properties)) {
		const parsed = toPropertyValue(value);
		if (parsed === undefined) return null;
		properties[key] = parsed;
	}
	return { aliases: m.aliases, tags: m.tags, properties };
}

function parseBlock(v: unknown): MarkdownBlock | null {
	const b = v as Json;
	const span = parseSpan(b?.span);
	if (!b || !span || !isStrings(b.headingPath)) return null;
	return { headingPath: b.headingPath, span };
}

function parseDoc(v: unknown): SourceDocument | null {
	const d = v as Json;
	if (!d || !isString(d.collectionId) || !isString(d.sourceId) || !isString(d.path) || !isString(d.title) || !isString(d.revision) || !isString(d.text)) return null;
	const metadata = parseMetadata(d.metadata);
	const blocks = Array.isArray(d.blocks) ? d.blocks.map(parseBlock) : [null];
	if (!metadata || blocks.some((b) => b === null)) return null;
	return {
		collectionId: d.collectionId as CollectionId,
		sourceId: d.sourceId as SourceId,
		path: d.path,
		title: d.title,
		revision: d.revision as Digest,
		metadata,
		text: d.text,
		blocks: blocks as MarkdownBlock[],
	};
}

function parsePassage(v: unknown): Passage | null {
	const p = v as Json;
	const span = parseSpan(p?.span);
	if (!p || !span || !isString(p.id) || !isString(p.sourceId) || !isString(p.revision) || !isString(p.inputHash)) return null;
	if (!isStrings(p.headingPath)) return null;
	return {
		id: p.id as PassageId,
		sourceId: p.sourceId as SourceId,
		revision: p.revision as Digest,
		headingPath: p.headingPath,
		span,
		inputHash: p.inputHash as Digest,
	};
}

export function decodeSnapshot(meta: string, vectors: Float32Array, dimensions: number): IndexSnapshot | null {
	let raw: Json;
	try {
		raw = JSON.parse(meta);
	} catch {
		return null;
	}
	if (!raw || raw.version !== VERSION || !isString(raw.fingerprint) || !isString(raw.extraction) || !Array.isArray(raw.sources)) return null;
	const sources: IndexedSource[] = [];
	let offset = 0;
	for (const entry of raw.sources as Json[]) {
		const doc = parseDoc(entry?.doc);
		const passages = Array.isArray(entry?.passages) ? entry.passages.map(parsePassage) : [null];
		if (!doc || passages.some((p) => p === null)) return null;
		// A span outside the text would throw at answer time, so a tampered index rebuilds instead.
		const lines = splitLines(doc.text);
		const inRange = (span: TextSpan): boolean =>
			span.start.line >= 1 &&
			span.end.line >= span.start.line &&
			span.end.line <= lines.length &&
			span.start.column >= 0 &&
			span.start.column <= lines[span.start.line - 1]!.length &&
			span.end.column >= 0 &&
			span.end.column <= lines[span.end.line - 1]!.length &&
			(span.start.line < span.end.line || span.start.column <= span.end.column);
		if (!doc.blocks.every((b) => inRange(b.span)) || !(passages as Passage[]).every((p) => inRange(p.span))) return null;
		const length = passages.length * dimensions;
		if (offset + length > vectors.length) return null;
		sources.push({ doc, passages: passages as Passage[], vectors: vectors.slice(offset, offset + length) });
		offset += length;
	}
	if (offset !== vectors.length) return null;
	return { fingerprint: raw.fingerprint as Digest, extraction: raw.extraction, sources };
}
