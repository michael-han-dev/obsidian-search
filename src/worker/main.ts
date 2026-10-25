import { ENCODER } from "../core/encoder-spec.ts";
import { Engine } from "./engine.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";
import { createWorkerEncoder } from "./remote-encoder.ts";

interface WorkerScope {
	postMessage(message: FromWorker, transfer: Transferable[]): void;
	addEventListener(type: "message", listener: (event: MessageEvent<ToWorker>) => void): void;
}

const scope = self as unknown as WorkerScope;

const engine = new Engine({
	spec: ENCODER,
	post: (message, transfer) => scope.postMessage(message, transfer ?? []),
	createEncoder: createWorkerEncoder,
});

scope.addEventListener("message", (event) => engine.handle(event.data));
