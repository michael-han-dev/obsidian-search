export type TokenId = number & { readonly __brand: "TokenId" };

export interface WordPieceTokenizer {
	readonly clsId: TokenId;
	readonly sepId: TokenId;
	readonly unkId: TokenId;
	encode(text: string): TokenId[];
}

export interface WordPieceOptions {
	readonly lowercase: boolean;
	readonly maxInputCharsPerWord?: number;
}

const WHITESPACE = /[\t\n\r\p{White_Space}]/u;
const OTHER = /\p{C}/u;
const NONSPACING_MARK = /\p{Mn}/gu;
const PUNCTUATION = /[!-/:-@[-`{-~\p{P}]/u;

function isChineseChar(cp: number): boolean {
	return (
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x20000 && cp <= 0x2a6df) ||
		(cp >= 0x2a700 && cp <= 0x2b73f) ||
		(cp >= 0x2b740 && cp <= 0x2b81f) ||
		(cp >= 0x2b920 && cp <= 0x2ceaf) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0x2f800 && cp <= 0x2fa1f)
	);
}

// Mirrors the BertNormalizer in Hugging Face `tokenizers`: clean, pad CJK,
// strip accents, then lowercase one code point at a time (no final-sigma rule).
function normalize(text: string, lowercase: boolean): string {
	let cleaned = "";
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (cp === 0 || cp === 0xfffd) continue;
		if (WHITESPACE.test(ch)) {
			cleaned += " ";
			continue;
		}
		if (OTHER.test(ch)) continue;
		cleaned += isChineseChar(cp) ? ` ${ch} ` : ch;
	}
	if (!lowercase) return cleaned;
	const stripped = cleaned.normalize("NFD").replace(NONSPACING_MARK, "");
	let lowered = "";
	for (const ch of stripped) lowered += ch.toLowerCase();
	return lowered;
}

function preTokenize(text: string): string[] {
	const words: string[] = [];
	let current = "";
	for (const ch of text) {
		if (WHITESPACE.test(ch)) {
			if (current) words.push(current);
			current = "";
		} else if (PUNCTUATION.test(ch)) {
			if (current) words.push(current);
			words.push(ch);
			current = "";
		} else {
			current += ch;
		}
	}
	if (current) words.push(current);
	return words;
}

export function createWordPieceTokenizer(vocabText: string, options: WordPieceOptions): WordPieceTokenizer {
	const vocab = new Map<string, TokenId>();
	vocabText.split("\n").forEach((line, index) => {
		const token = line.replace(/\r$/, "");
		if (token && !vocab.has(token)) vocab.set(token, index as TokenId);
	});
	const required = (token: string): TokenId => {
		const id = vocab.get(token);
		if (id === undefined) throw new Error(`Vocabulary is missing ${token}`);
		return id;
	};
	const unkId = required("[UNK]");
	const maxChars = options.maxInputCharsPerWord ?? 100;

	const encodeWord = (word: string, out: TokenId[]): void => {
		const chars = Array.from(word);
		if (chars.length > maxChars) {
			out.push(unkId);
			return;
		}
		const pieces: TokenId[] = [];
		let start = 0;
		while (start < chars.length) {
			let end = chars.length;
			let match: TokenId | undefined;
			while (start < end) {
				const piece = (start > 0 ? "##" : "") + chars.slice(start, end).join("");
				match = vocab.get(piece);
				if (match !== undefined) break;
				end--;
			}
			if (match === undefined) {
				out.push(unkId);
				return;
			}
			pieces.push(match);
			start = end;
		}
		out.push(...pieces);
	};

	return {
		clsId: required("[CLS]"),
		sepId: required("[SEP]"),
		unkId,
		encode(text) {
			const out: TokenId[] = [];
			for (const word of preTokenize(normalize(text, options.lowercase))) encodeWord(word, out);
			return out;
		},
	};
}
