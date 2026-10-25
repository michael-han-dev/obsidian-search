import ENCODER_SOURCE from "virtual:encoder-source";
import type { Encoder } from "./ort-encoder.ts";
import type { FromEncoder, ToEncoder } from "./protocol.ts";

// The session lives in its own worker because WebAssembly memory never shrinks:
// only terminating that worker gives the model's memory back.
export async function createWorkerEncoder(model: Uint8Array): Promise<Encoder> {
	const url = URL.createObjectURL(new Blob([ENCODER_SOURCE], { type: "text/javascript" }));
	const worker = new Worker(url, { name: "dowse-encoder" });
	URL.revokeObjectURL(url);
	let waiting: { readonly resolve: (reply: FromEncoder) => void; readonly reject: (error: Error) => void } | null = null;
	let broken: Error | null = null;
	worker.addEventListener("message", (event: MessageEvent<FromEncoder>) => {
		const pending = waiting;
		waiting = null;
		if (event.data.type === "error") pending?.reject(new Error(event.data.message));
		else pending?.resolve(event.data);
	});
	worker.addEventListener("error", (event) => {
		event.preventDefault();
		broken = new Error(event.message || "The model worker stopped unexpectedly");
		waiting?.reject(broken);
		waiting = null;
	});
	const call = (message: ToEncoder, transfer: Transferable[] = []) =>
		new Promise<FromEncoder>((resolve, reject) => {
			if (broken) return reject(broken);
			waiting = { resolve, reject };
			worker.postMessage(message, transfer);
		});
	try {
		await call({ type: "load", model }, [model.buffer]);
	} catch (error) {
		worker.terminate();
		throw error;
	}
	return {
		async embed(input) {
			const reply = await call({ type: "embed", input: Int32Array.from(input) });
			if (reply.type !== "embedded") throw new Error(`Unexpected reply ${reply.type}`);
			return reply.vector;
		},
		async dispose() {
			worker.terminate();
		},
	};
}
