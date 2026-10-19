import ORT_WASM_GZIP_BASE64 from "virtual:ort-wasm";
import { E5_SMALL_V2 } from "../core/encoder-spec.ts";
import { Engine } from "./engine.ts";
import { createOrtEncoder } from "./ort-encoder.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

interface WorkerScope {
	postMessage(message: FromWorker, transfer: Transferable[]): void;
	addEventListener(type: "message", listener: (event: MessageEvent<ToWorker>) => void): void;
}

const scope = self as unknown as WorkerScope;

async function inflate(base64: string): Promise<ArrayBuffer> {
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

let wasm: Promise<ArrayBuffer> | null = null;

const engine = new Engine({
	spec: E5_SMALL_V2,
	post: (message, transfer) => scope.postMessage(message, transfer ?? []),
	createEncoder: async (model) => createOrtEncoder(await (wasm ??= inflate(ORT_WASM_GZIP_BASE64)), model, E5_SMALL_V2),
});

scope.addEventListener("message", (event) => engine.handle(event.data));
