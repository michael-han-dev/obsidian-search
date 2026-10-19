import { type EncoderSpec, embeddingFingerprint, encodeQuery } from "../core/encoder-spec.ts";
import { extractDocument, MARKDOWN_ADAPTER_VERSION } from "../core/markdown.ts";
import { buildPassages, type EncodablePassage, PASSAGE_POLICY, type PassagePolicy } from "../core/passages.ts";
import { type IndexedSource, searchExact } from "../core/search.ts";
import { decodeSnapshot, encodeSnapshot } from "../core/snapshot.ts";
import { createWordPieceTokenizer, type WordPieceTokenizer } from "../core/tokenizer.ts";
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
	readonly reuse: ReadonlyMap<Digest, Float32Array>;
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
	readonly policy?: PassagePolicy;
	readonly snapshotDelayMs?: number;
}

const yieldToEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class Engine {
	private readonly deps: EngineDeps;
	private readonly policy: PassagePolicy;
	private readonly fingerprint: Promise<Digest>;
	private readonly sources = new Map<SourceId, SourceState>();
	private readonly pending = new Set<SourceId>();
	private model: ModelState = { kind: "model-needed" };
	private encoder: Encoder | null = null;
	private tokenizer: WordPieceTokenizer | null = null;
	private query: SearchRequest | null = null;
	private running = false;
	private generation = 0;
	private mutations: Promise<void> = Promise.resolve();
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	private dirty = false;

	constructor(deps: EngineDeps) {
		this.deps = deps;
		this.policy = deps.policy ?? PASSAGE_POLICY;
		this.fingerprint = embeddingFingerprint(deps.spec);
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
				return this.enqueue(() => this.sync(message.files, message.complete));
			case "remove":
				return this.enqueue(async () => this.remove(message.paths));
			case "dispose":
				return this.enqueue(() => this.dispose());
			default: {
				const unhandled: never = message;
				throw new Error(`Unknown message ${JSON.stringify(unhandled)}`);
			}
		}
	}

	async idle(): Promise<void> {
		for (;;) {
			await this.mutations;
			if (!this.running && this.query === null && (this.pending.size === 0 || !this.encoder)) return;
			await yieldToEvents();
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
		this.deps.post({ type: "state", model: this.model, coverage: this.coverage(), indexGeneration: this.generation as IndexGeneration });
	}

	private fail(error: unknown): void {
		this.model = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
		this.encoder = null;
		this.publish();
	}

	private async restore(meta: string, vectors: Float32Array): Promise<void> {
		const snapshot = decodeSnapshot(meta, vectors, this.deps.spec.dimensions);
		const compatible =
			snapshot &&
			snapshot.fingerprint === (await this.fingerprint) &&
			snapshot.adapterVersion === MARKDOWN_ADAPTER_VERSION &&
			snapshot.policy.maxInputTokens === this.policy.maxInputTokens &&
			snapshot.policy.maxContextTokens === this.policy.maxContextTokens;
		if (!compatible) return;
		for (const indexed of snapshot.sources) this.sources.set(indexed.sourceId, { kind: "embedded", indexed });
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

	private async sync(files: readonly SourceFile[], complete: boolean): Promise<void> {
		const seen = new Set<SourceId>();
		let changed = false;
		for (const file of files) {
			const doc = await extractDocument(file);
			seen.add(doc.sourceId);
			const existing = this.sources.get(doc.sourceId);
			const current = existing?.kind === "embedded" ? existing.indexed.revision : existing?.doc.revision;
			if (current === doc.revision) continue;
			this.sources.set(doc.sourceId, { kind: "pending", doc, reuse: reusableVectors(existing, this.deps.spec.dimensions), work: null, vectors: new Float32Array(0), next: 0 });
			this.pending.add(doc.sourceId);
			changed = true;
		}
		if (complete) {
			for (const id of this.sources.keys()) {
				if (!seen.has(id)) changed = this.drop(id) || changed;
			}
		}
		if (changed) this.changed();
	}

	private remove(paths: readonly string[]): void {
		let changed = false;
		for (const path of paths) changed = this.drop(path as SourceId) || changed;
		if (changed) this.changed();
	}

	private drop(id: SourceId): boolean {
		this.pending.delete(id);
		return this.sources.delete(id);
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
				if (query) {
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

	private async answer(request: SearchRequest): Promise<SearchResponse> {
		const coverage = this.coverage();
		if (request.text.trim() === "") return { kind: "empty", generation: request.generation };
		const { encoder, tokenizer } = this;
		if (!encoder || !tokenizer) return { kind: "not-ready", generation: request.generation, label: conceptLabel(this.model, coverage), coverage };
		const started = performance.now();
		const vector = await encoder.embed(encodeQuery(tokenizer, this.deps.spec, request.text));
		const embedded = performance.now();
		const files = searchExact(this.embeddedSources(), vector, request.limit);
		return {
			kind: "results",
			generation: request.generation,
			indexGeneration: this.generation as IndexGeneration,
			coverage,
			files,
			timings: { embedMs: embedded - started, searchMs: performance.now() - embedded },
		};
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
			const reused = state.reuse.get(item.passage.inputHash);
			const vector = reused ?? (await encoder.embed(item.input));
			if (this.sources.get(id) !== state) return;
			state.vectors.set(vector, state.next * dimensions);
			state.next++;
			if (!reused) return;
		}
		const { doc } = state;
		this.sources.set(id, {
			kind: "embedded",
			indexed: { sourceId: doc.sourceId, path: doc.path, title: doc.title, revision: doc.revision, passages: state.work.map((w) => w.passage), vectors: state.vectors },
		});
		this.pending.delete(id);
		this.changed();
	}

	private scheduleSnapshot(): void {
		if (!this.dirty || this.snapshotTimer || this.pending.size > 0 || this.model.kind === "disabled") return;
		this.snapshotTimer = setTimeout(() => void this.postSnapshot(), this.deps.snapshotDelayMs ?? 2000);
	}

	private async postSnapshot(): Promise<void> {
		this.snapshotTimer = null;
		if (this.pending.size > 0 || this.model.kind === "disabled") return;
		this.dirty = false;
		const encoded = encodeSnapshot({
			fingerprint: await this.fingerprint,
			adapterVersion: MARKDOWN_ADAPTER_VERSION,
			policy: this.policy,
			sources: [...this.embeddedSources()],
		});
		this.deps.post({ type: "snapshot", meta: encoded.meta, vectors: encoded.vectors }, [encoded.vectors.buffer]);
	}
}

function reusableVectors(state: SourceState | undefined, dimensions: number): ReadonlyMap<Digest, Float32Array> {
	const reuse = new Map<Digest, Float32Array>();
	if (state?.kind === "embedded") {
		state.indexed.passages.forEach((p, i) => reuse.set(p.inputHash, state.indexed.vectors.slice(i * dimensions, (i + 1) * dimensions)));
	} else if (state?.work) {
		for (let i = 0; i < state.next; i++) reuse.set(state.work[i]!.passage.inputHash, state.vectors.slice(i * dimensions, (i + 1) * dimensions));
		for (const [hash, vector] of state.reuse) if (!reuse.has(hash)) reuse.set(hash, vector);
	}
	return reuse;
}
