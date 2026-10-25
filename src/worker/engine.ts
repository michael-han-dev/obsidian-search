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
const HISTOGRAM_STEP_MS = 10;
const HISTOGRAM_BUCKETS = 21;
// A hidden window's timers can be throttled to about one per second; a port message is not.
const yieldPort = new MessageChannel();
const yielded: (() => void)[] = [];
yieldPort.port1.onmessage = () => yielded.shift()?.();
const yieldToEvents = () =>
	new Promise<void>((resolve) => {
		yielded.push(resolve);
		yieldPort.port2.postMessage(null);
	});

export class Engine {
	private readonly deps: EngineDeps;
	private readonly policy = PASSAGE_POLICY;
	private readonly fingerprint: Promise<Digest>;
	private readonly extraction: string;
	private readonly sources = new Map<SourceId, SourceState>();
	private readonly pending = new Set<SourceId>();
	private readonly retired = new Map<Digest, Float32Array>();
	private readonly known = new Map<Digest, Float32Array>();
	private model: ModelState = { kind: "model-needed" };
	private encoder: Encoder | null = null;
	private tokenizer: WordPieceTokenizer | null = null;
	private query: SearchRequest | null = null;
	private probe: { readonly texts: readonly string[]; readonly inputs: readonly (readonly number[])[] } | null = null;
	private running = false;
	private synced = false;
	private generation = 0;
	private passageInferences = 0;
	private queryInferences = 0;
	private sessionsCreated = 0;
	private slowestPassageMs = 0;
	private readonly passageMsHistogram: number[] = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
	private idleMs = 300_000;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
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
				return this.enqueue(() => this.loadModel(message.model, message.vocab, message.idleMs));
			case "model-unavailable":
				return this.enqueue(async () => this.setModel({ kind: "model-needed" }));
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
			(error: unknown) => {
				this.fail(error);
				void this.pump();
			},
		);
	}

	private coverage(): Coverage {
		return { embeddedSources: this.sources.size - this.pending.size, totalSources: this.sources.size };
	}

	private publish(): void {
		this.deps.post({
			type: "state",
			model: this.model,
			coverage: this.coverage(),
			indexGeneration: this.generation as IndexGeneration,
			counters: {
				passageInferences: this.passageInferences,
				queryInferences: this.queryInferences,
				sessionsCreated: this.sessionsCreated,
				sessionsLive: this.encoder ? 1 : 0,
				slowestPassageMs: Math.round(this.slowestPassageMs),
				passageMsHistogram: [...this.passageMsHistogram],
			},
		});
	}

	private setModel(model: ModelState): void {
		this.model = model;
		this.publish();
	}

	private fail(error: unknown): void {
		const encoder = this.encoder;
		this.encoder = null;
		void encoder?.dispose();
		this.setModel({ kind: "failed", message: error instanceof Error ? error.message : String(error), retry: "load" });
	}

	private async restore(meta: string, vectors: Float32Array): Promise<void> {
		const snapshot = decodeSnapshot(meta, vectors, this.deps.spec.dimensions);
		if (!snapshot || snapshot.fingerprint !== (await this.fingerprint)) return;
		for (const indexed of snapshot.sources) {
			if (snapshot.extraction === this.extraction) {
				this.sources.set(indexed.doc.sourceId, { kind: "embedded", indexed });
				this.remember(indexed);
			} else this.retire({ kind: "embedded", indexed });
		}
		this.generation++;
		this.publish();
	}

	private async loadModel(model: Uint8Array, vocab: string, idleMs: number): Promise<void> {
		this.idleMs = idleMs;
		this.setModel({ kind: "loading" });
		this.tokenizer = createWordPieceTokenizer(vocab, { lowercase: this.deps.spec.lowercase });
		const encoder = await this.deps.createEncoder(model);
		await this.encoder?.dispose();
		this.encoder = encoder;
		this.sessionsCreated++;
		this.setModel({ kind: "loaded" });
		this.touch();
	}

	private touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = this.encoder ? setTimeout(() => this.enqueue(() => this.release()), this.idleMs) : null;
	}

	private async release(): Promise<void> {
		this.idleTimer = null;
		if (!this.encoder) return;
		if (this.running || this.query || this.pending.size > 0) return this.touch();
		const encoder = this.encoder;
		this.encoder = null;
		await encoder.dispose();
		this.setModel({ kind: "released" });
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
		if (complete) this.synced = true;
		if (changed) this.changed();
	}

	private drop(id: SourceId): boolean {
		const state = this.sources.get(id);
		if (!state) return false;
		this.retire(state);
		this.pending.delete(id);
		return this.sources.delete(id);
	}

	private remember({ passages, vectors }: IndexedSource): void {
		const d = this.deps.spec.dimensions;
		passages.forEach((p, i) => this.known.set(p.inputHash, vectors.subarray(i * d, (i + 1) * d)));
	}

	private retire(state: SourceState): void {
		const d = this.deps.spec.dimensions;
		const done = state.kind === "embedded" ? state.indexed.passages : (state.work?.slice(0, state.next).map((w) => w.passage) ?? []);
		const vectors = state.kind === "embedded" ? state.indexed.vectors : state.vectors;
		done.forEach((p, i) => {
			this.retired.set(p.inputHash, vectors.slice(i * d, (i + 1) * d));
			if (this.known.get(p.inputHash)?.buffer === vectors.buffer) this.known.delete(p.inputHash);
		});
	}

	private changed(): void {
		this.generation++;
		this.dirty = true;
		this.publish();
	}

	private async dispose(): Promise<void> {
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.snapshotTimer = null;
		this.idleTimer = null;
		this.query = null;
		const encoder = this.encoder;
		this.encoder = null;
		this.model = { kind: "disabled" };
		await encoder?.dispose();
		this.deps.post({ type: "disposed" });
	}

	private wantsEncoder(): boolean {
		return !!this.probe || this.pending.size > 0 || (!!this.query && this.query.query.relevance !== "");
	}

	private async pump(): Promise<void> {
		if (this.running) return;
		this.running = true;
		let failed = false;
		try {
			for (;;) {
				const { query, probe, encoder, tokenizer } = this;
				const waitingForModel = !encoder && (this.model.kind === "loading" || this.model.kind === "released");
				if (this.model.kind === "released" && this.wantsEncoder()) {
					this.setModel({ kind: "loading" });
					this.deps.post({ type: "need-model" });
				}
				if (probe && encoder && tokenizer) {
					this.probe = null;
					const vectors: Float32Array[] = [];
					for (const input of probe.inputs) vectors.push(await encoder.embed(input as TokenId[]));
					this.deps.post({ type: "probed", ids: probe.texts.map((t) => tokenizer.encode(t)), vectors });
				} else if (query && this.synced && !(query.query.relevance !== "" && waitingForModel)) {
					this.query = null;
					const response = await this.answer(query);
					this.deps.post({ type: "response", response });
					if (response.kind === "results") this.publish();
				} else if (encoder && this.pending.size > 0) {
					await this.embedStep();
				} else {
					break;
				}
				await yieldToEvents();
			}
		} catch (error) {
			this.fail(error);
			failed = true;
		} finally {
			this.running = false;
		}
		if (failed) return void this.pump();
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
		this.queryInferences++;
		this.touch();
		const embedded = performance.now();
		// No await below: the response must describe one state of the index.
		const eligible = this.eligible(compileFilter(query.constraints));
		const threshold = this.deps.spec.relevanceThreshold;
		return {
			kind: "results",
			generation,
			indexGeneration: this.generation as IndexGeneration,
			coverage: eligible.coverage,
			files: searchExact(eligible.embedded, vector, limit).filter((f) => f.score >= threshold),
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
			state.work = await buildPassages(state.doc, tokenizer, this.deps.spec, await this.fingerprint, this.policy);
			state.vectors = new Float32Array(state.work.length * dimensions);
		}
		while (state.next < state.work.length) {
			const item = state.work[state.next]!;
			const reused = this.retired.get(item.passage.inputHash) ?? this.known.get(item.passage.inputHash);
			if (!reused) this.passageInferences++;
			const started = performance.now();
			const vector = reused ?? (await encoder.embed(item.input));
			if (!reused) {
				const ms = performance.now() - started;
				this.slowestPassageMs = Math.max(this.slowestPassageMs, ms);
				this.passageMsHistogram[Math.min(HISTOGRAM_BUCKETS - 1, Math.floor(ms / HISTOGRAM_STEP_MS))]!++;
			}
			if (this.sources.get(id) !== state) return;
			state.vectors.set(vector, state.next * dimensions);
			state.next++;
			if (!reused) {
				this.touch();
				return;
			}
		}
		const indexed = { doc: state.doc, passages: state.work.map((w) => w.passage), vectors: state.vectors };
		this.sources.set(id, { kind: "embedded", indexed });
		this.remember(indexed);
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
