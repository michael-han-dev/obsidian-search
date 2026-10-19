import type { Digest, FileResult, Passage, PassageHit, SourceId } from "./types.ts";

export interface IndexedSource {
	readonly sourceId: SourceId;
	readonly path: string;
	readonly title: string;
	readonly revision: Digest;
	readonly passages: readonly Passage[];
	readonly vectors: Float32Array;
}

export function meanPoolNormalized(hidden: Float32Array, tokens: number, dimensions: number): Float32Array {
	const pooled = new Float32Array(dimensions);
	for (let t = 0; t < tokens; t++) {
		const row = t * dimensions;
		for (let d = 0; d < dimensions; d++) pooled[d]! += hidden[row + d]!;
	}
	let norm = 0;
	for (let d = 0; d < dimensions; d++) norm += pooled[d]! * pooled[d]!;
	const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
	for (let d = 0; d < dimensions; d++) pooled[d]! *= scale;
	return pooled;
}

export function searchExact(
	sources: Iterable<IndexedSource>,
	query: Float32Array,
	limit: number,
	passagesPerFile = 3,
): FileResult[] {
	const dimensions = query.length;
	const files: FileResult[] = [];
	for (const source of sources) {
		const hits: PassageHit[] = [];
		source.passages.forEach((passage, i) => {
			let score = 0;
			const row = i * dimensions;
			for (let d = 0; d < dimensions; d++) score += query[d]! * source.vectors[row + d]!;
			hits.push({ passageId: passage.id, headingPath: passage.headingPath, text: passage.text, span: passage.span, score });
		});
		if (hits.length === 0) continue;
		hits.sort((a, b) => b.score - a.score);
		const top = hits.slice(0, passagesPerFile);
		files.push({ sourceId: source.sourceId, path: source.path, title: source.title, revision: source.revision, score: top[0]!.score, passages: top });
	}
	files.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return files.slice(0, limit);
}
