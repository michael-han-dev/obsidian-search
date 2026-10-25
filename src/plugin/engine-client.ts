import WORKER_SOURCE from "virtual:worker-source";
import type { Coverage, IndexGeneration, ModelState, ParsedQuery, QueryGeneration, SearchResponse } from "../core/types.ts";
import type { Counters, FromWorker, ToWorker } from "../worker/protocol.ts";

export interface EngineStatus {
	readonly model: ModelState;
	readonly coverage: Coverage;
	readonly indexGeneration: IndexGeneration;
	readonly counters: Counters;
}

export interface EngineClientOptions {
	readonly onSnapshot: (meta: string, vectors: Float32Array) => void;
	readonly onNeedModel: () => void;
}

export class EngineClient {
	private readonly worker: Worker;
	private readonly listeners = new Set<(status: EngineStatus) => void>();
	private generation = 0;
	private waiting: { readonly generation: number; readonly resolve: (response: SearchResponse | null) => void } | null = null;
	private disposed: (() => void) | null = null;
	private probing: ((result: { ids: readonly (readonly number[])[]; vectors: readonly Float32Array[] }) => void) | null = null;
	private crashed = false;
	status: EngineStatus = {
		model: { kind: "model-needed" },
		coverage: { embeddedSources: 0, totalSources: 0 },
		indexGeneration: 0 as IndexGeneration,
		counters: { passageInferences: 0, queryInferences: 0, sessionsCreated: 0, sessionsLive: 0, slowestPassageMs: 0, passageMsHistogram: [] },
	};

	constructor(options: EngineClientOptions) {
		const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
		this.worker = new Worker(url, { name: "dowse-engine" });
		URL.revokeObjectURL(url);
		this.worker.addEventListener("error", (event) => {
			event.preventDefault();
			this.crashed = true;
			this.cancel();
			this.setStatus({ ...this.status, model: { kind: "failed", message: `The search engine stopped unexpectedly: ${event.message || "unknown error"}`, retry: "restart" } });
		});
		this.worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
			if (this.crashed) return;
			const message = event.data;
			switch (message.type) {
				case "state":
					this.setStatus({ model: message.model, coverage: message.coverage, indexGeneration: message.indexGeneration, counters: message.counters });
					return;
				case "need-model":
					options.onNeedModel();
					return;
				case "response":
					if (this.waiting?.generation === message.response.generation) {
						this.waiting.resolve(message.response);
						this.waiting = null;
					}
					return;
				case "snapshot":
					options.onSnapshot(message.meta, message.vectors);
					return;
				case "disposed":
					this.disposed?.();
					return;
				case "probed":
					this.probing?.({ ids: message.ids, vectors: message.vectors });
					this.probing = null;
					return;
				default: {
					const unhandled: never = message;
					throw new Error(`Unknown worker message ${JSON.stringify(unhandled)}`);
				}
			}
		});
	}

	private setStatus(status: EngineStatus): void {
		this.status = status;
		for (const listener of this.listeners) listener(status);
	}

	post(message: ToWorker, transfer: Transferable[] = []): void {
		this.worker.postMessage(message, transfer);
	}

	onStatus(listener: (status: EngineStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	probe(texts: readonly string[], inputs: readonly (readonly number[])[]): Promise<{ ids: readonly (readonly number[])[]; vectors: readonly Float32Array[] }> {
		return new Promise((resolve) => {
			this.probing = resolve;
			this.post({ type: "probe", texts, inputs });
		});
	}

	search(query: ParsedQuery, limit: number): Promise<SearchResponse | null> {
		this.cancel();
		if (this.crashed) return Promise.resolve(null);
		const generation = ++this.generation;
		return new Promise((resolve) => {
			this.waiting = { generation, resolve };
			this.post({ type: "search", request: { generation: generation as QueryGeneration, query, limit } });
		});
	}

	cancel(): void {
		this.waiting?.resolve(null);
		this.waiting = null;
	}

	async dispose(): Promise<void> {
		this.cancel();
		this.listeners.clear();
		if (this.crashed) return this.worker.terminate();
		const acknowledged = new Promise<void>((resolve) => (this.disposed = resolve));
		this.post({ type: "dispose" });
		await Promise.race([acknowledged, new Promise((resolve) => setTimeout(resolve, 2000))]);
		this.worker.terminate();
	}
}
