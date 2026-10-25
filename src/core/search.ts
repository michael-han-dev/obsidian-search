import { splitLines, textInSpan } from "./markdown.ts";
import type { FileResult, Passage, SourceDocument } from "./types.ts";

export interface IndexedSource {
	readonly doc: SourceDocument;
	readonly passages: readonly Passage[];
	readonly vectors: Float32Array;
}

export function poolNormalized(hidden: Float32Array, tokens: number, dimensions: number, pooling: "mean" | "cls"): Float32Array {
	const pooled = new Float32Array(dimensions);
	for (let t = 0; t < (pooling === "cls" ? 1 : tokens); t++) {
		const row = t * dimensions;
		for (let d = 0; d < dimensions; d++) pooled[d]! += hidden[row + d]!;
	}
	let norm = 0;
	for (let d = 0; d < dimensions; d++) norm += pooled[d]! * pooled[d]!;
	const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
	for (let d = 0; d < dimensions; d++) pooled[d]! *= scale;
	return pooled;
}

export function compareCodePoints(a: string, b: string): number {
	for (let i = 0, j = 0; i < a.length && j < b.length; ) {
		const x = a.codePointAt(i)!;
		const y = b.codePointAt(j)!;
		if (x !== y) return x - y;
		i += x > 0xffff ? 2 : 1;
		j += y > 0xffff ? 2 : 1;
	}
	return a.length - b.length;
}

interface Ranked {
	readonly source: IndexedSource;
	readonly top: readonly { readonly index: number; readonly score: number }[];
}

export function searchExact(sources: Iterable<IndexedSource>, query: Float32Array, limit: number, passagesPerFile = 3): FileResult[] {
	const dimensions = query.length;
	const ranked: Ranked[] = [];
	for (const source of sources) {
		const top: { index: number; score: number }[] = [];
		for (let i = 0; i < source.passages.length; i++) {
			let score = 0;
			const row = i * dimensions;
			for (let d = 0; d < dimensions; d++) score += query[d]! * source.vectors[row + d]!;
			if (top.length === passagesPerFile && score <= top.at(-1)!.score) continue;
			const at = top.findIndex((t) => score > t.score);
			top.splice(at < 0 ? top.length : at, 0, { index: i, score });
			if (top.length > passagesPerFile) top.pop();
		}
		if (top.length > 0) ranked.push({ source, top });
	}
	ranked.sort((a, b) => b.top[0]!.score - a.top[0]!.score || compareCodePoints(a.source.doc.path, b.source.doc.path));
	return ranked.slice(0, limit).map(({ source: { doc, passages }, top }) => {
		const lines = splitLines(doc.text);
		return {
			sourceId: doc.sourceId,
			path: doc.path,
			title: doc.title,
			revision: doc.revision,
			score: top[0]!.score,
			passages: top.map(({ index, score }) => {
				const passage = passages[index]!;
				return { passageId: passage.id, headingPath: passage.headingPath, text: textInSpan(lines, passage.span), span: passage.span, score };
			}),
		};
	});
}
