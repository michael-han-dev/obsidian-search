import type { Coverage, IndexGeneration, ModelState, SearchRequest, SearchResponse, SourceFile } from "../core/types.ts";

export interface Counters {
	readonly passageInferences: number;
	readonly queryInferences: number;
	readonly sessionsCreated: number;
	readonly sessionsLive: number;
	readonly slowestPassageMs: number;
	// Passage inferences by duration in 10 ms steps; the last entry counts everything slower.
	readonly passageMsHistogram: readonly number[];
}

export type ToWorker =
	| { readonly type: "restore"; readonly meta: string; readonly vectors: Float32Array }
	| { readonly type: "load-model"; readonly model: Uint8Array; readonly vocab: string; readonly idleMs: number }
	| { readonly type: "model-unavailable" }
	| { readonly type: "sync"; readonly files: readonly SourceFile[]; readonly removed: readonly string[]; readonly complete: boolean }
	| { readonly type: "search"; readonly request: SearchRequest }
	| { readonly type: "dispose" }
	// For the end-to-end checks, which compare tokens and embeddings with reference outputs.
	| { readonly type: "probe"; readonly texts: readonly string[]; readonly inputs: readonly (readonly number[])[] };

export type FromWorker =
	| { readonly type: "state"; readonly model: ModelState; readonly coverage: Coverage; readonly indexGeneration: IndexGeneration; readonly counters: Counters }
	| { readonly type: "need-model" }
	| { readonly type: "response"; readonly response: SearchResponse }
	| { readonly type: "snapshot"; readonly meta: string; readonly vectors: Float32Array }
	| { readonly type: "disposed" }
	| { readonly type: "probed"; readonly ids: readonly (readonly number[])[]; readonly vectors: readonly Float32Array[] };

export type ToEncoder = { readonly type: "load"; readonly model: Uint8Array } | { readonly type: "embed"; readonly input: Int32Array };

export type FromEncoder =
	| { readonly type: "loaded" }
	| { readonly type: "embedded"; readonly vector: Float32Array }
	| { readonly type: "error"; readonly message: string };
