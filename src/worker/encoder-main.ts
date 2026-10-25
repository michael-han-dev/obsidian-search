import ORT_WASM_GZIP_BASE64 from "virtual:ort-wasm";
import { ENCODER } from "../core/encoder-spec.ts";
import type { TokenId } from "../core/tokenizer.ts";
import { createOrtEncoder, type Encoder } from "./ort-encoder.ts";
import type { FromEncoder, ToEncoder } from "./protocol.ts";

interface EncoderScope {
	postMessage(message: FromEncoder, transfer?: Transferable[]): void;
	addEventListener(type: "message", listener: (event: MessageEvent<ToEncoder>) => void): void;
}

const scope = self as unknown as EncoderScope;

async function inflate(base64: string): Promise<ArrayBuffer> {
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

let encoder: Encoder | null = null;
let queue: Promise<void> = Promise.resolve();

async function handle(message: ToEncoder): Promise<void> {
	try {
		if (message.type === "load") {
			encoder = await createOrtEncoder(await inflate(ORT_WASM_GZIP_BASE64), message.model, ENCODER);
			scope.postMessage({ type: "loaded" });
			return;
		}
		if (!encoder) throw new Error("The model is not loaded");
		const vector = await encoder.embed(Array.from(message.input) as TokenId[]);
		scope.postMessage({ type: "embedded", vector }, [vector.buffer]);
	} catch (error) {
		scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
	}
}

scope.addEventListener("message", (event) => {
	queue = queue.then(() => handle(event.data));
});
