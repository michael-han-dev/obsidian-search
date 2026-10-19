import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-web/wasm";

ort.env.wasm.wasmBinary = await readFile("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm");
ort.env.wasm.numThreads = Number(process.argv[2] ?? 1);
const session = await ort.InferenceSession.create(await readFile("dev-assets/e5-small-v2/model.onnx"), { executionProviders: ["wasm"] });
const tensor = (n: number, v: bigint) => new ort.Tensor("int64", new BigInt64Array(n).fill(v), [1, n]);
for (const n of [16, 32, 64, 128, 192, 256, 384, 512]) {
	const feeds = { input_ids: tensor(n, 2000n), attention_mask: tensor(n, 1n), token_type_ids: tensor(n, 0n) };
	await session.run(feeds);
	const times: number[] = [];
	for (let i = 0; i < 7; i++) {
		const t = performance.now();
		await session.run(feeds);
		times.push(performance.now() - t);
	}
	times.sort((a, b) => a - b);
	console.log(`threads ${ort.env.wasm.numThreads} tokens ${n} median ${times[3]!.toFixed(1)} ms max ${times[6]!.toFixed(1)} ms`);
}
