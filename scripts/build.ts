import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { build, type Plugin } from "esbuild";

const virtual = (modules: Record<string, () => Promise<string>>): Plugin => ({
	name: "virtual",
	setup(b) {
		b.onResolve({ filter: /^virtual:/ }, (args) => ({ path: args.path, namespace: "virtual" }));
		b.onLoad({ filter: /.*/, namespace: "virtual" }, async (args) => {
			const load = modules[args.path];
			if (!load) throw new Error(`Unknown virtual module ${args.path}`);
			return { contents: `export default ${JSON.stringify(await load())};`, loader: "js" };
		});
	},
});

const wasmGzipBase64 = async () => gzipSync(await readFile("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"), { level: 9 }).toString("base64");

const worker = await build({
	entryPoints: ["src/worker/main.ts"],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	minify: true,
	write: false,
	logLevel: "warning",
	plugins: [virtual({ "virtual:ort-wasm": wasmGzipBase64 })],
});
const workerSource = worker.outputFiles[0]!.text;

await mkdir("dist", { recursive: true });
await build({
	entryPoints: ["src/plugin/main.ts"],
	outfile: "dist/main.js",
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "es2022",
	minify: true,
	external: ["obsidian", "electron", "@codemirror/*"],
	logLevel: "warning",
	plugins: [virtual({ "virtual:worker-source": async () => workerSource })],
});
await copyFile("manifest.json", "dist/manifest.json");
await copyFile("styles.css", "dist/styles.css");
for (const name of ["main.js", "manifest.json", "styles.css"]) console.log(`dist/${name} ${(await stat(`dist/${name}`)).size} bytes`);
console.log(`worker bundle ${Buffer.byteLength(workerSource)} bytes`);
