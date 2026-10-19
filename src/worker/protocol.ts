import type { Coverage, IndexGeneration, ModelState, SearchRequest, SearchResponse, SourceFile } from "../core/types.ts";

export type ToWorker =
	| { readonly type: "restore"; readonly meta: string; readonly vectors: Float32Array }
	| { readonly type: "load-model"; readonly model: Uint8Array; readonly vocab: string }
	| { readonly type: "sync"; readonly files: readonly SourceFile[]; readonly complete: boolean }
	| { readonly type: "remove"; readonly paths: readonly string[] }
	| { readonly type: "search"; readonly request: SearchRequest }
	| { readonly type: "dispose" };

export type FromWorker =
	| { readonly type: "state"; readonly model: ModelState; readonly coverage: Coverage; readonly indexGeneration: IndexGeneration }
	| { readonly type: "response"; readonly response: SearchResponse }
	| { readonly type: "snapshot"; readonly meta: string; readonly vectors: Float32Array }
	| { readonly type: "disposed" };
