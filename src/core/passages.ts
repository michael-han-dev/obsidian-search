import { type EncoderSpec, embeddingKey } from "./encoder-spec.ts";
import { splitLines, textInSpan } from "./markdown.ts";
import type { TokenId, WordPieceTokenizer } from "./tokenizer.ts";
import type { Digest, Passage, PassageId, SourceDocument, TextSpan } from "./types.ts";

export interface PassagePolicy {
	readonly maxInputTokens: number;
	readonly maxContextTokens: number;
}

export const PASSAGE_POLICY: PassagePolicy = { maxInputTokens: 80, maxContextTokens: 32 };

export interface EncodablePassage {
	readonly passage: Passage;
	readonly input: readonly TokenId[];
}

interface Piece {
	readonly headingPath: readonly string[];
	readonly text: string;
	readonly span: TextSpan;
}

function splitByLines(piece: Piece): Piece[] {
	return piece.text.split("\n").flatMap((text, offset) => {
		if (text.trim() === "") return [];
		const line = piece.span.start.line + offset;
		const column = offset === 0 ? piece.span.start.column : 0;
		return [{ headingPath: piece.headingPath, text, span: { start: { line, column }, end: { line, column: column + text.length } } }];
	});
}

function splitLine(piece: Piece, budget: number, count: (text: string) => number): Piece[] {
	const { line, column } = piece.span.start;
	const out: Piece[] = [];
	const push = (from: number, to: number) =>
		out.push({ headingPath: piece.headingPath, text: piece.text.slice(from, to), span: { start: { line, column: column + from }, end: { line, column: column + to } } });
	const slices = (text: string): string[] => {
		if (count(text) <= budget) return [text];
		const chars = Array.from(text);
		const half = chars.slice(0, chars.length >> 1).join("");
		return [...slices(half), ...slices(text.slice(half.length))];
	};
	let from = -1;
	let to = 0;
	let tokens = 0;
	for (const match of piece.text.matchAll(/\S+/gu)) {
		const start = match.index;
		const word = match[0];
		const n = count(word);
		if (from >= 0 && tokens + Math.min(n, budget) > budget) {
			push(from, to);
			from = -1;
			tokens = 0;
		}
		if (n <= budget) {
			if (from < 0) from = start;
			to = start + word.length;
			tokens += n;
			continue;
		}
		let at = start;
		for (const slice of slices(word)) {
			push(at, at + slice.length);
			at += slice.length;
		}
	}
	if (from >= 0) push(from, to);
	return out;
}

export async function buildPassages(
	doc: SourceDocument,
	tokenizer: WordPieceTokenizer,
	spec: EncoderSpec,
	fingerprint: Digest,
	policy: PassagePolicy = PASSAGE_POLICY,
): Promise<EncodablePassage[]> {
	const prefix = tokenizer.encode(spec.passagePrefix);
	const titleIds = tokenizer.encode([doc.title, ...doc.metadata.aliases].join(", "));
	const groups: { pieces: { piece: Piece; ids: readonly TokenId[] }[]; tokens: number }[] = [];
	const count = (text: string) => tokenizer.encode(text).length;

	const contextFor = (headingPath: readonly string[]): TokenId[] =>
		[...titleIds, ...tokenizer.encode(headingPath.join(" > "))].slice(0, policy.maxContextTokens);
	const budgetFor = (headingPath: readonly string[]): number =>
		policy.maxInputTokens - 2 - prefix.length - contextFor(headingPath).length;

	const place = (piece: Piece): void => {
		const ids = tokenizer.encode(piece.text);
		const budget = budgetFor(piece.headingPath);
		if (ids.length > budget) {
			const lines = splitByLines(piece);
			(lines.length > 1 ? lines : splitLine(piece, budget, count)).forEach(place);
			return;
		}
		const last = groups.at(-1);
		const sameSection = last && last.pieces[0]!.piece.headingPath.join("\u0000") === piece.headingPath.join("\u0000");
		if (last && sameSection && last.tokens + ids.length <= budget) {
			last.pieces.push({ piece, ids });
			last.tokens += ids.length;
			return;
		}
		groups.push({ pieces: [{ piece, ids }], tokens: ids.length });
	};
	const lines = splitLines(doc.text);
	for (const block of doc.blocks) place({ ...block, text: textInSpan(lines, block.span) });

	return Promise.all(
		groups.map(async (group, ordinal): Promise<EncodablePassage> => {
			const first = group.pieces[0]!.piece;
			const last = group.pieces.at(-1)!.piece;
			const input = [tokenizer.clsId, ...prefix, ...contextFor(first.headingPath), ...group.pieces.flatMap((p) => p.ids), tokenizer.sepId];
			return {
				input,
				passage: {
					id: `${doc.sourceId}#${ordinal}` as PassageId,
					sourceId: doc.sourceId,
					revision: doc.revision,
					headingPath: first.headingPath,
					span: { start: first.span.start, end: last.span.end },
					inputHash: await embeddingKey(fingerprint, input),
				},
			};
		}),
	);
}
