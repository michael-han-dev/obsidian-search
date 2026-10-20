import WORKER_SOURCE from "virtual:worker-source";
import type { Coverage, IndexGeneration, ModelState, ParsedQuery, QueryGeneration, SearchResponse } from "../core/types.ts";
import type { FromWorker, ToWorker } from "../worker/protocol.ts";

export interface EngineStatus {
	readonly model: ModelState;
	readonly coverage: Coverage;
	readonly indexGeneration: IndexGeneration;
	readonly passageInferences: number;
}

export interface EngineClientOptions {
	readonly onSnapshot: (meta: string, vectors: Float32Array) => void;
}

export class EngineClient {
	private readonly worker: Worker;
	private readonly listeners = new Set<(status: EngineStatus) => void>();
	private generation = 0;
	private waiting: { readonly generation: number; readonly resolve: (response: SearchResponse | null) => void } | null = null;
	private disposed: (() => void) | null = null;
	private probing: ((result: { ids: readonly (readonly number[])[]; vectors: readonly Float32Array[] }) => void) | null = null;
	status: EngineStatus = { model: { kind: "model-needed" }, coverage: { embeddedSources: 0, totalSources: 0 }, indexGeneration: 0 as IndexGeneration, passageInferences: 0 };

	constructor(options: EngineClientOptions) {
		const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
		this.worker = new Worker(url, { name: "dowse-engine" });
		URL.revokeObjectURL(url);
		this.worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
			const message = event.data;
			switch (message.type) {
				case "state":
					this.status = { model: message.model, coverage: message.coverage, indexGeneration: message.indexGeneration, passageInferences: message.passageInferences };
					for (const listener of this.listeners) listener(this.status);
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
		const acknowledged = new Promise<void>((resolve) => (this.disposed = resolve));
		this.post({ type: "dispose" });
		await Promise.race([acknowledged, new Promise((resolve) => setTimeout(resolve, 2000))]);
		this.worker.terminate();
	}
}
