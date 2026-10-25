// Usage: node scripts/eval/runtime.ts [modelsDir] [out]
// Each candidate runs in its own process so memory readings do not mix.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as ort from "onnxruntime-web/wasm";

const LENGTHS = [16, 32, 64, 112, 128, 256, 512];
const mb = (n: number) => Math.round(n / 2 ** 20);
const memory = () => {
	const m = process.memoryUsage();
	return { rssMb: mb(m.rss), arrayBuffersMb: mb(m.arrayBuffers), externalMb: mb(m.external) };
};

async function measure(dir: string, onnx: string) {
	ort.env.wasm.wasmBinary = await readFile("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm");
	ort.env.wasm.numThreads = 1;
	const before = memory();
	const bytes = await readFile(join(dir, onnx));
	const started = performance.now();
	const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
	const createMs = performance.now() - started;
	const loaded = memory();
	const tensor = (n: number, fill: (i: number) => bigint) => new ort.Tensor("int64", BigInt64Array.from({ length: n }, (_, i) => fill(i)), [1, n]);
	const latency: Record<number, { medianMs: number; maxMs: number }> = {};
	for (const n of LENGTHS) {
		const feeds: Record<string, ort.Tensor> = {};
		for (const name of session.inputNames) {
			if (name === "input_ids") feeds[name] = tensor(n, (i) => (i === 0 ? 101n : i === n - 1 ? 102n : BigInt(1000 + ((i * 7919) % 28000))));
			else if (name === "attention_mask") feeds[name] = tensor(n, () => 1n);
			else feeds[name] = tensor(n, () => 0n);
		}
		await session.run(feeds);
		const times: number[] = [];
		for (let i = 0; i < 7; i++) {
			const t = performance.now();
			await session.run(feeds);
			times.push(performance.now() - t);
		}
		times.sort((a, b) => a - b);
		latency[n] = { medianMs: Number(times[3]!.toFixed(1)), maxMs: Number(times[6]!.toFixed(1)) };
	}
	const afterRuns = memory();
	await session.release();
	(globalThis as { gc?: () => void }).gc?.();
	const released = memory();
	return { inputs: session.inputNames, outputs: session.outputNames, createMs: Math.round(createMs), memory: { before, loaded, afterRuns, released }, latency };
}

if (process.argv[2] === "--one") {
	console.log(JSON.stringify(await measure(process.argv[3]!, process.argv[4]!)));
} else {
	const models = process.argv[2] ?? "dev-assets/models";
	const out = process.argv[3] ?? "dev-assets/m3/eval/runtime.json";
	const manifest: { name: string; onnx: string; files: Record<string, { bytes: number }> }[] = JSON.parse(await readFile(join(models, "manifest.json"), "utf8"));
	const rows = [];
	for (const c of manifest) {
		const result = JSON.parse(execFileSync("node", ["--expose-gc", "scripts/eval/runtime.ts", "--one", join(models, c.name), c.onnx], { encoding: "utf8", maxBuffer: 1 << 24 }));
		rows.push({ name: c.name, modelMb: mb(c.files[c.onnx]!.bytes), ...result });
		console.log(c.name, JSON.stringify({ createMs: result.createMs, loadedRssMb: result.memory.loaded.rssMb, at112: result.latency[112], at256: result.latency[256] }));
	}
	await writeFile(out, `${JSON.stringify(rows, null, 1)}\n`);
}
