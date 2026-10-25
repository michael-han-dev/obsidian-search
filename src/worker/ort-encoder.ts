import * as ort from "onnxruntime-web/wasm";
import type { EncoderSpec } from "../core/encoder-spec.ts";
import { poolNormalized } from "../core/search.ts";
import type { TokenId } from "../core/tokenizer.ts";

export interface Encoder {
	embed(input: readonly TokenId[]): Promise<Float32Array>;
	dispose(): Promise<void>;
}

const fail = (input: string): never => {
	throw new Error(`The model needs an input Dowse does not provide: ${input}`);
};

export async function createOrtEncoder(wasmBinary: ArrayBuffer, model: Uint8Array, spec: EncoderSpec): Promise<Encoder> {
	ort.env.wasm.wasmBinary = wasmBinary;
	ort.env.wasm.numThreads = 1;
	ort.env.wasm.proxy = false;
	const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
	const int64 = (values: BigInt64Array) => new ort.Tensor("int64", values, [1, values.length]);
	return {
		async embed(input) {
			const n = input.length;
			const ids = new BigInt64Array(n);
			for (let i = 0; i < n; i++) ids[i] = BigInt(input[i]!);
			const available: Record<string, () => ort.Tensor> = {
				input_ids: () => int64(ids),
				attention_mask: () => int64(new BigInt64Array(n).fill(1n)),
				token_type_ids: () => int64(new BigInt64Array(n)),
			};
			const output = await session.run(Object.fromEntries(session.inputNames.map((name) => [name, available[name]?.() ?? fail(name)])));
			const hidden = output[spec.output];
			if (!hidden || !(hidden.data instanceof Float32Array)) throw new Error(`Model returned no ${spec.output}`);
			return poolNormalized(hidden.data, n, spec.dimensions, spec.pooling);
		},
		dispose: () => session.release(),
	};
}
