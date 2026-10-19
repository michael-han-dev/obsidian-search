import { type EncoderSpec, inputHash } from "./encoder-spec.ts";
import type { TokenId, WordPieceTokenizer } from "./tokenizer.ts";
import type { MarkdownBlock, Passage, PassageId, SourceDocument } from "./types.ts";

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
	readonly block: MarkdownBlock;
	readonly ids: readonly TokenId[];
}

function splitByLines(block: MarkdownBlock): MarkdownBlock[] {
	return block.text.split("\n").flatMap((text, offset) => {
		if (text.trim() === "") return [];
		const line = block.span.start.line + offset;
		return [{ headingPath: block.headingPath, text, span: { start: { line, column: 0 }, end: { line, column: text.length } } }];
	});
}

export async function buildPassages(
	doc: SourceDocument,
	tokenizer: WordPieceTokenizer,
	spec: EncoderSpec,
	policy: PassagePolicy = PASSAGE_POLICY,
): Promise<EncodablePassage[]> {
	const prefix = tokenizer.encode(spec.passagePrefix);
	const titleIds = tokenizer.encode([doc.title, ...doc.aliases].join(", "));
	const groups: { pieces: Piece[]; tokens: number; truncated: boolean }[] = [];

	const contextFor = (headingPath: readonly string[]): TokenId[] =>
		[...titleIds, ...tokenizer.encode(headingPath.join(" > "))].slice(0, policy.maxContextTokens);
	const budgetFor = (headingPath: readonly string[]): number =>
		policy.maxInputTokens - 2 - prefix.length - contextFor(headingPath).length;

	const place = (block: MarkdownBlock): void => {
		const ids = tokenizer.encode(block.text);
		const budget = budgetFor(block.headingPath);
		if (ids.length > budget) {
			const lines = splitByLines(block);
			if (lines.length > 1) {
				lines.forEach(place);
				return;
			}
			groups.push({ pieces: [{ block, ids: ids.slice(0, budget) }], tokens: budget, truncated: true });
			return;
		}
		const last = groups.at(-1);
		const sameSection = last && !last.truncated && last.pieces[0]!.block.headingPath.join("\u0000") === block.headingPath.join("\u0000");
		if (last && sameSection && last.tokens + ids.length <= budget) {
			last.pieces.push({ block, ids });
			last.tokens += ids.length;
			return;
		}
		groups.push({ pieces: [{ block, ids }], tokens: ids.length, truncated: false });
	};
	doc.blocks.forEach(place);

	return Promise.all(
		groups.map(async (group, ordinal) => {
			const first = group.pieces[0]!.block;
			const last = group.pieces.at(-1)!.block;
			const input = [tokenizer.clsId, ...prefix, ...contextFor(first.headingPath), ...group.pieces.flatMap((p) => p.ids), tokenizer.sepId];
			return {
				input,
				passage: {
					id: `${doc.sourceId}#${ordinal}` as PassageId,
					sourceId: doc.sourceId,
					revision: doc.revision,
					headingPath: first.headingPath,
					text: group.pieces.map((p) => p.block.text).join("\n\n"),
					span: { start: first.span.start, end: last.span.end },
					truncated: group.truncated,
					inputHash: await inputHash(input),
				},
			};
		}),
	);
}
