import { type EncoderSpec, inputHash } from "./encoder-spec.ts";
import type { TokenId, WordPieceTokenizer } from "./tokenizer.ts";
import { splitLines, textInSpan } from "./markdown.ts";
import type { Passage, PassageId, SourceDocument, TextSpan } from "./types.ts";

export interface PassagePolicy {
	readonly maxInputTokens: number;
	readonly maxContextTokens: number;
}

export const PASSAGE_POLICY: PassagePolicy = { maxInputTokens: 112, maxContextTokens: 32 };

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
		return [{ headingPath: piece.headingPath, text, span: { start: { line, column: 0 }, end: { line, column: text.length } } }];
	});
}

export async function buildPassages(
	doc: SourceDocument,
	tokenizer: WordPieceTokenizer,
	spec: EncoderSpec,
	policy: PassagePolicy = PASSAGE_POLICY,
): Promise<EncodablePassage[]> {
	const prefix = tokenizer.encode(spec.passagePrefix);
	const titleIds = tokenizer.encode([doc.title, ...doc.metadata.aliases].join(", "));
	const groups: { pieces: { piece: Piece; ids: readonly TokenId[] }[]; tokens: number; truncated: boolean }[] = [];

	const contextFor = (headingPath: readonly string[]): TokenId[] =>
		[...titleIds, ...tokenizer.encode(headingPath.join(" > "))].slice(0, policy.maxContextTokens);
	const budgetFor = (headingPath: readonly string[]): number =>
		policy.maxInputTokens - 2 - prefix.length - contextFor(headingPath).length;

	const place = (piece: Piece): void => {
		const ids = tokenizer.encode(piece.text);
		const budget = budgetFor(piece.headingPath);
		if (ids.length > budget) {
			const lines = splitByLines(piece);
			if (lines.length > 1) {
				lines.forEach(place);
				return;
			}
			groups.push({ pieces: [{ piece, ids: ids.slice(0, budget) }], tokens: budget, truncated: true });
			return;
		}
		const last = groups.at(-1);
		const sameSection = last && !last.truncated && last.pieces[0]!.piece.headingPath.join("\u0000") === piece.headingPath.join("\u0000");
		if (last && sameSection && last.tokens + ids.length <= budget) {
			last.pieces.push({ piece, ids });
			last.tokens += ids.length;
			return;
		}
		groups.push({ pieces: [{ piece, ids }], tokens: ids.length, truncated: false });
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
					inputHash: await inputHash(input),
				},
			};
		}),
	);
}
