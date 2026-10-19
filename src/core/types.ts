export type Brand<T, B extends string> = T & { readonly __brand: B };

export type CollectionId = Brand<string, "CollectionId">;
export type SourceId = Brand<string, "SourceId">;
export type PassageId = Brand<string, "PassageId">;
export type Digest = Brand<string, "Digest">;
export type QueryGeneration = Brand<number, "QueryGeneration">;
export type IndexGeneration = Brand<number, "IndexGeneration">;

export const VAULT_COLLECTION = "vault" as CollectionId;

export interface TextPosition {
	readonly line: number;
	readonly column: number;
}

export interface TextSpan {
	readonly start: TextPosition;
	readonly end: TextPosition;
}

export interface SourceFile {
	readonly collectionId: CollectionId;
	readonly path: string;
	readonly text: string;
	readonly aliases: readonly string[];
}

export interface MarkdownBlock {
	readonly headingPath: readonly string[];
	readonly text: string;
	readonly span: TextSpan;
}

export interface SourceDocument {
	readonly collectionId: CollectionId;
	readonly sourceId: SourceId;
	readonly path: string;
	readonly title: string;
	readonly aliases: readonly string[];
	readonly revision: Digest;
	readonly adapterVersion: string;
	readonly blocks: readonly MarkdownBlock[];
}

export interface Passage {
	readonly id: PassageId;
	readonly sourceId: SourceId;
	readonly revision: Digest;
	readonly headingPath: readonly string[];
	readonly text: string;
	readonly span: TextSpan;
	readonly truncated: boolean;
	readonly inputHash: Digest;
}

export interface PassageHit {
	readonly passageId: PassageId;
	readonly headingPath: readonly string[];
	readonly text: string;
	readonly span: TextSpan;
	readonly score: number;
}

export interface FileResult {
	readonly sourceId: SourceId;
	readonly path: string;
	readonly title: string;
	readonly revision: Digest;
	readonly score: number;
	readonly passages: readonly PassageHit[];
}

export interface Coverage {
	readonly embeddedSources: number;
	readonly totalSources: number;
}

export type ModelState =
	| { readonly kind: "model-needed" }
	| { readonly kind: "acquiring"; readonly doneBytes: number; readonly totalBytes: number }
	| { readonly kind: "loading" }
	| { readonly kind: "loaded" }
	| { readonly kind: "failed"; readonly message: string }
	| { readonly kind: "disabled" };

export type ConceptLabel = "model-needed" | "acquiring" | "loading" | "indexing" | "ready" | "failed" | "disabled";

export function conceptLabel(model: ModelState, coverage: Coverage): ConceptLabel {
	switch (model.kind) {
		case "loaded":
			return coverage.embeddedSources < coverage.totalSources ? "indexing" : "ready";
		case "model-needed":
		case "acquiring":
		case "loading":
		case "failed":
		case "disabled":
			return model.kind;
		default: {
			const unhandled: never = model;
			return unhandled;
		}
	}
}

export interface SearchRequest {
	readonly generation: QueryGeneration;
	readonly text: string;
	readonly limit: number;
}

export type SearchResponse =
	| { readonly kind: "empty"; readonly generation: QueryGeneration }
	| { readonly kind: "not-ready"; readonly generation: QueryGeneration; readonly label: ConceptLabel; readonly coverage: Coverage }
	| {
			readonly kind: "results";
			readonly generation: QueryGeneration;
			readonly indexGeneration: IndexGeneration;
			readonly coverage: Coverage;
			readonly files: readonly FileResult[];
			readonly timings: { readonly embedMs: number; readonly searchMs: number };
	  };
