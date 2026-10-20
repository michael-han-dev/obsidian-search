import type { Coverage, IndexGeneration, ModelState, SearchRequest, SearchResponse, SourceFile } from "../core/types.ts";

export type ToWorker =
	| { readonly type: "restore"; readonly meta: string; readonly vectors: Float32Array }
	| { readonly type: "load-model"; readonly model: Uint8Array; readonly vocab: string }
	| { readonly type: "sync"; readonly files: readonly SourceFile[]; readonly removed: readonly string[]; readonly complete: boolean }
	| { readonly type: "search"; readonly request: SearchRequest }
	| { readonly type: "dispose" }
	// For the end-to-end checks, which compare tokens and embeddings with reference outputs.
	| { readonly type: "probe"; readonly texts: readonly string[]; readonly inputs: readonly (readonly number[])[] };

export type FromWorker =
	| { readonly type: "state"; readonly model: ModelState; readonly coverage: Coverage; readonly indexGeneration: IndexGeneration; readonly passageInferences: number }
	| { readonly type: "response"; readonly response: SearchResponse }
	| { readonly type: "snapshot"; readonly meta: string; readonly vectors: Float32Array }
	| { readonly type: "disposed" }
	| { readonly type: "probed"; readonly ids: readonly (readonly number[])[]; readonly vectors: readonly Float32Array[] };
