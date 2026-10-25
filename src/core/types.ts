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

export type PropertyValue = string | number | boolean | null | readonly PropertyValue[];

export interface NoteMetadata {
	readonly aliases: readonly string[];
	readonly tags: readonly string[];
	readonly properties: Readonly<Record<string, PropertyValue>>;
}

export interface SourceFile {
	readonly collectionId: CollectionId;
	readonly path: string;
	readonly text: string;
	readonly metadata: NoteMetadata;
}

export interface MarkdownBlock {
	readonly headingPath: readonly string[];
	readonly span: TextSpan;
}

export interface SourceDocument {
	readonly collectionId: CollectionId;
	readonly sourceId: SourceId;
	readonly path: string;
	readonly title: string;
	readonly revision: Digest;
	readonly metadata: NoteMetadata;
	readonly text: string;
	readonly blocks: readonly MarkdownBlock[];
}

export interface Passage {
	readonly id: PassageId;
	readonly sourceId: SourceId;
	readonly revision: Digest;
	readonly headingPath: readonly string[];
	readonly span: TextSpan;
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

export interface BlockEvidence {
	readonly headingPath: readonly string[];
	readonly text: string;
	readonly span: TextSpan;
}

export interface MatchedFile {
	readonly sourceId: SourceId;
	readonly path: string;
	readonly title: string;
	readonly revision: Digest;
	readonly evidence: BlockEvidence | null;
}

export interface Coverage {
	readonly embeddedSources: number;
	readonly totalSources: number;
}

export type Recovery = "acquire" | "load" | "restart";

export type ModelState =
	| { readonly kind: "model-needed" }
	| { readonly kind: "acquiring"; readonly doneBytes: number; readonly totalBytes: number }
	| { readonly kind: "loading" }
	| { readonly kind: "loaded" }
	| { readonly kind: "released" }
	| { readonly kind: "failed"; readonly message: string; readonly retry: Recovery }
	| { readonly kind: "disabled" };

export type ConceptLabel = "model-needed" | "acquiring" | "loading" | "indexing" | "ready" | "failed" | "disabled";

export function conceptLabel(model: ModelState, coverage: Coverage): ConceptLabel {
	switch (model.kind) {
		case "loaded":
		case "released":
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

export type PropertyLiteral = string | number | boolean;

export type Test =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "word"; readonly word: string }
	| { readonly kind: "file"; readonly text: string }
	| { readonly kind: "path"; readonly text: string }
	| { readonly kind: "tag"; readonly tag: string }
	| { readonly kind: "property"; readonly key: string; readonly value: PropertyLiteral };

export interface Constraint {
	readonly negated: boolean;
	readonly test: Test;
}

export interface ParsedQuery {
	readonly constraints: readonly Constraint[];
	readonly relevance: string;
}

export interface SearchRequest {
	readonly generation: QueryGeneration;
	readonly query: ParsedQuery;
	readonly limit: number;
}

export type SearchResponse =
	| { readonly kind: "empty"; readonly generation: QueryGeneration }
	| { readonly kind: "not-ready"; readonly generation: QueryGeneration; readonly label: ConceptLabel; readonly coverage: Coverage }
	| {
			readonly kind: "matching";
			readonly generation: QueryGeneration;
			readonly indexGeneration: IndexGeneration;
			readonly files: readonly MatchedFile[];
			readonly total: number;
			readonly timings: { readonly searchMs: number };
	  }
	| {
			readonly kind: "results";
			readonly generation: QueryGeneration;
			readonly indexGeneration: IndexGeneration;
			readonly coverage: Coverage;
			readonly files: readonly FileResult[];
			readonly timings: { readonly embedMs: number; readonly searchMs: number };
	  };

export type SearchOutcome = SearchResponse | { readonly kind: "invalid"; readonly error: string };
