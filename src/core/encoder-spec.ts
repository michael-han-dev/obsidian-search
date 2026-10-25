import { digest } from "./hash.ts";
import type { TokenId, WordPieceTokenizer } from "./tokenizer.ts";
import type { Digest } from "./types.ts";

export interface ModelFile {
	readonly name: string;
	readonly path: string;
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
	readonly output: "last_hidden_state" | "token_embeddings";
	readonly pooling: "mean" | "cls";
	readonly normalize: true;
	readonly lowercase: boolean;
	readonly precision: "fp32";
	readonly templateRevision: string;
	readonly relevanceThreshold: number;
}

export const ENCODER: EncoderSpec = {
	id: "BAAI/bge-small-en-v1.5",
	revision: "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
	license: "MIT",
	folderName: "BAAI-bge-small-en-v1.5-5c38ec7",
	model: { name: "model.onnx", path: "onnx/model.onnx", bytes: 133093490, sha256: "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35" },
	vocab: { name: "vocab.txt", path: "vocab.txt", bytes: 231508, sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3" },
	dimensions: 384,
	maxTokens: 512,
	queryPrefix: "Represent this sentence for searching relevant passages: ",
	passagePrefix: "",
	output: "last_hidden_state",
	pooling: "cls",
	normalize: true,
	lowercase: true,
	precision: "fp32",
	templateRevision: "title-aliases-headings@1",
	relevanceThreshold: 0.53,
};

export function embeddingFingerprint(spec: EncoderSpec): Promise<Digest> {
	return digest(
		JSON.stringify([
			spec.id,
			spec.revision,
			spec.model.sha256,
			spec.vocab.sha256,
			spec.lowercase,
			spec.queryPrefix,
			spec.passagePrefix,
			spec.templateRevision,
			spec.output,
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

const KEY_VERSION = new TextEncoder().encode("dowse-embedding-key@1\u0000");

export function embeddingKey(fingerprint: Digest, ids: readonly TokenId[]): Promise<Digest> {
	const head = new TextEncoder().encode(`${fingerprint}\u0000`);
	const body = new Uint8Array(Int32Array.from(ids).buffer);
	const bytes = new Uint8Array(KEY_VERSION.length + head.length + body.length);
	bytes.set(KEY_VERSION, 0);
	bytes.set(head, KEY_VERSION.length);
	bytes.set(body, KEY_VERSION.length + head.length);
	return digest(bytes);
}
