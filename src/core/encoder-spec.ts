import { digest } from "./hash.ts";
import type { TokenId, WordPieceTokenizer } from "./tokenizer.ts";
import type { Digest } from "./types.ts";

export interface ModelFile {
	readonly name: string;
	readonly bytes: number;
	readonly sha256: string;
}

export interface EncoderSpec {
	readonly id: string;
	readonly revision: string;
	readonly license: string;
	readonly folderName: string;
	readonly model: ModelFile;
	readonly vocab: ModelFile;
	readonly dimensions: number;
	readonly maxTokens: number;
	readonly queryPrefix: string;
	readonly passagePrefix: string;
	readonly pooling: "mean";
	readonly normalize: true;
	readonly lowercase: boolean;
	readonly precision: "fp32";
	readonly templateRevision: string;
}

export const E5_SMALL_V2: EncoderSpec = {
	id: "intfloat/e5-small-v2",
	revision: "ffb93f3bd4047442299a41ebb6fa998a38507c52",
	license: "MIT",
	folderName: "intfloat-e5-small-v2-ffb93f3",
	model: { name: "model.onnx", bytes: 133093468, sha256: "4b8205be2a3c5fc53c6534d76a2012064f7309c162b806f2889c6ec8ec4fdcba" },
	vocab: { name: "vocab.txt", bytes: 231508, sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3" },
	dimensions: 384,
	maxTokens: 512,
	queryPrefix: "query: ",
	passagePrefix: "passage: ",
	pooling: "mean",
	normalize: true,
	lowercase: true,
	precision: "fp32",
	templateRevision: "title-aliases-headings@1",
};

export function embeddingFingerprint(spec: EncoderSpec): Promise<Digest> {
	return digest(
		JSON.stringify([
			spec.id,
			spec.revision,
			spec.model.sha256,
			spec.vocab.sha256,
			spec.lowercase,
			spec.templateRevision,
			spec.pooling,
			spec.normalize,
			spec.dimensions,
			spec.precision,
		]),
	);
}

export function encodeQuery(tokenizer: WordPieceTokenizer, spec: EncoderSpec, text: string): TokenId[] {
	const body = tokenizer.encode(spec.queryPrefix + text).slice(0, spec.maxTokens - 2);
	return [tokenizer.clsId, ...body, tokenizer.sepId];
}

export function inputHash(ids: readonly TokenId[]): Promise<Digest> {
	return digest(new Uint8Array(Int32Array.from(ids).buffer));
}
