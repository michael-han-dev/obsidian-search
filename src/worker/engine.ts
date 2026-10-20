import { type EncoderSpec, embeddingFingerprint, encodeQuery } from "../core/encoder-spec.ts";
import { compileFilter, type DocFilter, matchingFiles } from "../core/filter.ts";
import { extractDocument, MARKDOWN_ADAPTER_VERSION } from "../core/markdown.ts";
import { buildPassages, type EncodablePassage, PASSAGE_POLICY } from "../core/passages.ts";
import { type IndexedSource, searchExact } from "../core/search.ts";
import { decodeSnapshot, encodeSnapshot } from "../core/snapshot.ts";
import { createWordPieceTokenizer, type TokenId, type WordPieceTokenizer } from "../core/tokenizer.ts";
import {
	type Coverage,
	conceptLabel,
	type Digest,
	type IndexGeneration,
	type ModelState,
	type SearchRequest,
	type SearchResponse,
	type SourceDocument,
	type SourceFile,
	type SourceId,
} from "../core/types.ts";
import type { Encoder } from "./ort-encoder.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

interface PendingSource {
	readonly kind: "pending";
	readonly doc: SourceDocument;
	work: EncodablePassage[] | null;
	vectors: Float32Array;
	next: number;
}

interface EmbeddedSource {
	readonly kind: "embedded";
	readonly indexed: IndexedSource;
}

type SourceState = PendingSource | EmbeddedSource;

export interface EngineDeps {
	readonly post: (message: FromWorker, transfer?: Transferable[]) => void;
	readonly createEncoder: (model: Uint8Array) => Promise<Encoder>;
	readonly spec: EncoderSpec;
}

const SNAPSHOT_DELAY_MS = 2000;
const yieldToEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class Engine {
	private readonly deps: EngineDeps;
	private readonly policy = PASSAGE_POLICY;
	private readonly fingerprint: Promise<Digest>;
	private readonly extraction: string;
	private readonly sources = new Map<SourceId, SourceState>();
	private readonly pending = new Set<SourceId>();
	private readonly retired = new Map<Digest, Float32Array>();
	private model: ModelState = { kind: "model-needed" };
	private encoder: Encoder | null = null;
	private tokenizer: WordPieceTokenizer | null = null;
	private query: SearchRequest | null = null;
	private probe: { readonly texts: readonly string[]; readonly inputs: readonly (readonly number[])[] } | null = null;
	private running = false;
	private generation = 0;
	private passageInferences = 0;
	private mutations: Promise<void> = Promise.resolve();
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	private dirty = false;

	constructor(deps: EngineDeps) {
		this.deps = deps;
		this.fingerprint = embeddingFingerprint(deps.spec);
		this.extraction = `${MARKDOWN_ADAPTER_VERSION}|${this.policy.maxInputTokens}|${this.policy.maxContextTokens}`;
	}

	handle(message: ToWorker): void {
		switch (message.type) {
			case "search":
				this.query = message.request;
				void this.pump();
				return;
			case "restore":
				return this.enqueue(() => this.restore(message.meta, message.vectors));
			case "load-model":
				return this.enqueue(() => this.loadModel(message.model, message.vocab));
			case "sync":
				return this.enqueue(() => this.sync(message.files, message.removed, message.complete));
			case "dispose":
				return this.enqueue(() => this.dispose());
			case "probe":
				this.probe = message;
				void this.pump();
				return;
			default: {
				const unhandled: never = message;
				throw new Error(`Unknown message ${JSON.stringify(unhandled)}`);
			}
		}
	}

	private enqueue(operation: () => Promise<void>): void {
		this.mutations = this.mutations.then(operation).then(
			() => void this.pump(),
			(error: unknown) => this.fail(error),
		);
	}

	private coverage(): Coverage {
		return { embeddedSources: this.sources.size - this.pending.size, totalSources: this.sources.size };
	}

	private publish(): void {
		this.deps.post({ type: "state", model: this.model, coverage: this.coverage(), indexGeneration: this.generation as IndexGeneration, passageInferences: this.passageInferences });
	}

	private fail(error: unknown): void {
		this.model = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
		this.encoder = null;
		this.publish();
	}

	private async restore(meta: string, vectors: Float32Array): Promise<void> {
		const snapshot = decodeSnapshot(meta, vectors, this.deps.spec.dimensions);
		if (!snapshot || snapshot.fingerprint !== (await this.fingerprint)) return;
		for (const indexed of snapshot.sources) {
			if (snapshot.extraction === this.extraction) this.sources.set(indexed.doc.sourceId, { kind: "embedded", indexed });
			else this.retire({ kind: "embedded", indexed });
		}
		this.generation++;
		this.publish();
	}

	private async loadModel(model: Uint8Array, vocab: string): Promise<void> {
		this.model = { kind: "loading" };
		this.publish();
		this.tokenizer = createWordPieceTokenizer(vocab, { lowercase: this.deps.spec.lowercase });
		this.encoder = await this.deps.createEncoder(model);
		this.model = { kind: "loaded" };
		this.publish();
	}

	// Removals ride in the same message so a rename's two halves land together and reuse vectors.
	private async sync(files: readonly SourceFile[], removed: readonly string[], complete: boolean): Promise<void> {
		const seen = new Set<SourceId>();
		let changed = false;
		for (const file of files) {
			const doc = await extractDocument(file);
			seen.add(doc.sourceId);
			const existing = this.sources.get(doc.sourceId);
			const current = existing?.kind === "embedded" ? existing.indexed.doc : existing?.doc;
			if (current && current.revision === doc.revision && JSON.stringify(current.metadata) === JSON.stringify(doc.metadata)) continue;
			if (existing) this.retire(existing);
			this.sources.set(doc.sourceId, { kind: "pending", doc, work: null, vectors: new Float32Array(0), next: 0 });
			this.pending.add(doc.sourceId);
			changed = true;
		}
		for (const id of complete ? [...this.sources.keys()].filter((id) => !seen.has(id)) : (removed as SourceId[])) changed = this.drop(id) || changed;
		if (this.pending.size === 0) this.retired.clear();
		if (changed) this.changed();
	}

	private drop(id: SourceId): boolean {
		const state = this.sources.get(id);
		if (!state) return false;
		this.retire(state);
		this.pending.delete(id);
		return this.sources.delete(id);
	}

	private retire(state: SourceState): void {
		const dimensions = this.deps.spec.dimensions;
		const done = state.kind === "embedded" ? state.indexed.passages : (state.work?.slice(0, state.next).map((w) => w.passage) ?? []);
		const vectors = state.kind === "embedded" ? state.indexed.vectors : state.vectors;
		done.forEach((p, i) => this.retired.set(p.inputHash, vectors.slice(i * dimensions, (i + 1) * dimensions)));
	}

	private changed(): void {
		this.generation++;
		this.dirty = true;
		this.publish();
	}

	private async dispose(): Promise<void> {
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		this.snapshotTimer = null;
		this.query = null;
		const encoder = this.encoder;
		this.encoder = null;
		this.model = { kind: "disabled" };
		await encoder?.dispose();
		this.deps.post({ type: "disposed" });
	}

	private async pump(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			for (;;) {
				const query = this.query;
				const { probe, encoder, tokenizer } = this;
				if (probe && encoder && tokenizer) {
					this.probe = null;
					const vectors: Float32Array[] = [];
					for (const input of probe.inputs) vectors.push(await encoder.embed(input as TokenId[]));
					this.deps.post({ type: "probed", ids: probe.texts.map((t) => tokenizer.encode(t)), vectors });
				} else if (query) {
					this.query = null;
					this.deps.post({ type: "response", response: await this.answer(query) });
				} else if (this.encoder && this.pending.size > 0) {
					await this.embedStep();
				} else {
					break;
				}
				await yieldToEvents();
			}
		} catch (error) {
			this.fail(error);
		} finally {
			this.running = false;
		}
		this.scheduleSnapshot();
	}

	private async answer({ generation, query, limit }: SearchRequest): Promise<SearchResponse> {
		if (query.constraints.length === 0 && query.relevance === "") return { kind: "empty", generation };
		const started = performance.now();
		if (query.relevance === "") {
			const { files, total } = matchingFiles(this.documents(), query.constraints, limit);
			return { kind: "matching", generation, indexGeneration: this.generation as IndexGeneration, files, total, timings: { searchMs: performance.now() - started } };
		}
		const { encoder, tokenizer } = this;
		if (!encoder || !tokenizer) return { kind: "not-ready", generation, label: conceptLabel(this.model, this.coverage()), coverage: this.coverage() };
		const vector = await encoder.embed(encodeQuery(tokenizer, this.deps.spec, query.relevance));
		const embedded = performance.now();
		// No await below: the response must describe one state of the index.
		const eligible = this.eligible(compileFilter(query.constraints));
		return {
			kind: "results",
			generation,
			indexGeneration: this.generation as IndexGeneration,
			coverage: eligible.coverage,
			files: searchExact(eligible.embedded, vector, limit),
			timings: { embedMs: embedded - started, searchMs: performance.now() - embedded },
		};
	}

	private *documents(): Iterable<SourceDocument> {
		for (const state of this.sources.values()) yield state.kind === "embedded" ? state.indexed.doc : state.doc;
	}

	private eligible(filter: DocFilter): { embedded: IndexedSource[]; coverage: Coverage } {
		const embedded: IndexedSource[] = [];
		let total = 0;
		for (const state of this.sources.values()) {
			if (!filter(state.kind === "embedded" ? state.indexed.doc : state.doc)) continue;
			total++;
			if (state.kind === "embedded") embedded.push(state.indexed);
		}
		return { embedded, coverage: { embeddedSources: embedded.length, totalSources: total } };
	}

	private *embeddedSources(): Iterable<IndexedSource> {
		for (const state of this.sources.values()) if (state.kind === "embedded") yield state.indexed;
	}

	private async embedStep(): Promise<void> {
		const { encoder, tokenizer } = this;
		const id = this.pending.values().next().value;
		const state = id === undefined ? undefined : this.sources.get(id);
		if (!encoder || !tokenizer || id === undefined || state?.kind !== "pending") return;
		const dimensions = this.deps.spec.dimensions;
		if (!state.work) {
			state.work = await buildPassages(state.doc, tokenizer, this.deps.spec, this.policy);
			state.vectors = new Float32Array(state.work.length * dimensions);
		}
		while (state.next < state.work.length) {
			const item = state.work[state.next]!;
			const reused = this.retired.get(item.passage.inputHash);
			if (!reused) this.passageInferences++;
			const vector = reused ?? (await encoder.embed(item.input));
			if (this.sources.get(id) !== state) return;
			state.vectors.set(vector, state.next * dimensions);
			state.next++;
			if (!reused) return;
		}
		this.sources.set(id, { kind: "embedded", indexed: { doc: state.doc, passages: state.work.map((w) => w.passage), vectors: state.vectors } });
		this.pending.delete(id);
		if (this.pending.size === 0) this.retired.clear();
		this.changed();
	}

	private scheduleSnapshot(): void {
		if (!this.dirty || this.snapshotTimer || this.pending.size > 0 || this.model.kind === "disabled") return;
		this.snapshotTimer = setTimeout(() => void this.postSnapshot(), SNAPSHOT_DELAY_MS);
	}

	private async postSnapshot(): Promise<void> {
		this.snapshotTimer = null;
		if (this.pending.size > 0 || this.model.kind === "disabled") return;
		this.dirty = false;
		const encoded = encodeSnapshot({ fingerprint: await this.fingerprint, extraction: this.extraction, sources: [...this.embeddedSources()] });
		this.deps.post({ type: "snapshot", meta: encoded.meta, vectors: encoded.vectors }, [encoded.vectors.buffer]);
	}
}
