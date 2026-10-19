import type { PassagePolicy } from "./passages.ts";
import type { IndexedSource } from "./search.ts";
import type { Digest, Passage, PassageId, SourceId, TextSpan } from "./types.ts";

export interface IndexSnapshot {
	readonly fingerprint: Digest;
	readonly adapterVersion: string;
	readonly policy: PassagePolicy;
	readonly sources: readonly IndexedSource[];
}

export interface EncodedSnapshot {
	readonly meta: string;
	readonly vectors: Float32Array;
}

const VERSION = 1;

export function encodeSnapshot(snapshot: IndexSnapshot): EncodedSnapshot {
	const total = snapshot.sources.reduce((n, s) => n + s.vectors.length, 0);
	const vectors = new Float32Array(total);
	let offset = 0;
	const sources = snapshot.sources.map((s) => {
		vectors.set(s.vectors, offset);
		offset += s.vectors.length;
		return { sourceId: s.sourceId, path: s.path, title: s.title, revision: s.revision, passages: s.passages };
	});
	return { meta: JSON.stringify({ version: VERSION, fingerprint: snapshot.fingerprint, adapterVersion: snapshot.adapterVersion, policy: snapshot.policy, sources }), vectors };
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseSpan(v: unknown): TextSpan | null {
	const s = v as { start?: { line?: unknown; column?: unknown }; end?: { line?: unknown; column?: unknown } } | null;
	if (!s?.start || !s.end) return null;
	const { start, end } = s;
	if (!isNumber(start.line) || !isNumber(start.column) || !isNumber(end.line) || !isNumber(end.column)) return null;
	return { start: { line: start.line, column: start.column }, end: { line: end.line, column: end.column } };
}

function parsePassage(v: unknown): Passage | null {
	const p = v as Record<string, unknown> | null;
	if (!p || !isString(p.id) || !isString(p.sourceId) || !isString(p.revision) || !isString(p.text) || !isString(p.inputHash)) return null;
	if (!Array.isArray(p.headingPath) || !p.headingPath.every(isString) || typeof p.truncated !== "boolean") return null;
	const span = parseSpan(p.span);
	if (!span) return null;
	return {
		id: p.id as PassageId,
		sourceId: p.sourceId as SourceId,
		revision: p.revision as Digest,
		headingPath: p.headingPath,
		text: p.text,
		span,
		truncated: p.truncated,
		inputHash: p.inputHash as Digest,
	};
}

export function decodeSnapshot(meta: string, vectors: Float32Array, dimensions: number): IndexSnapshot | null {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(meta);
	} catch {
		return null;
	}
	if (raw.version !== VERSION || !isString(raw.fingerprint) || !isString(raw.adapterVersion) || !Array.isArray(raw.sources)) return null;
	const policy = raw.policy as Record<string, unknown> | null;
	if (!policy || !isNumber(policy.maxInputTokens) || !isNumber(policy.maxContextTokens)) return null;
	const sources: IndexedSource[] = [];
	let offset = 0;
	for (const entry of raw.sources as Record<string, unknown>[]) {
		if (!entry || !isString(entry.sourceId) || !isString(entry.path) || !isString(entry.title) || !isString(entry.revision) || !Array.isArray(entry.passages)) return null;
		const passages = entry.passages.map(parsePassage);
		if (passages.some((p) => p === null)) return null;
		const length = passages.length * dimensions;
		if (offset + length > vectors.length) return null;
		sources.push({
			sourceId: entry.sourceId as SourceId,
			path: entry.path,
			title: entry.title,
			revision: entry.revision as Digest,
			passages: passages as Passage[],
			vectors: vectors.slice(offset, offset + length),
		});
		offset += length;
	}
	if (offset !== vectors.length) return null;
	return {
		fingerprint: raw.fingerprint as Digest,
		adapterVersion: raw.adapterVersion,
		policy: { maxInputTokens: policy.maxInputTokens, maxContextTokens: policy.maxContextTokens },
		sources,
	};
}
