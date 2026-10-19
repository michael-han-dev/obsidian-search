import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EncoderSpec } from "../src/core/encoder-spec.ts";
import { E5_SMALL_V2 } from "../src/core/encoder-spec.ts";
import { importModel, installedModelDir, loadInstalledModel } from "../src/plugin/model-files.ts";
import { dataRoot, readIndex, vaultIndexDir, writeIndex } from "../src/plugin/storage.ts";

const temp = () => mkdtemp(join(tmpdir(), "dowse-test-"));

test("puts local data in the platform's per-user application data folder", () => {
	assert.equal(dataRoot("darwin", {}, "/Users/ada"), "/Users/ada/Library/Application Support/dowse");
	assert.equal(dataRoot("linux", { XDG_DATA_HOME: "/data" }, "/home/ada"), "/data/dowse");
	assert.equal(dataRoot("linux", {}, "/home/ada"), "/home/ada/.local/share/dowse");
	assert.equal(dataRoot("darwin", { DOWSE_DATA_DIR: "/tmp/dowse-dev" }, "/Users/ada"), "/tmp/dowse-dev");
});

test("keys each vault by its canonical folder, so a symlink shares the index and another vault does not", async () => {
	const base = await temp();
	await mkdir(join(base, "Work Notes"));
	await mkdir(join(base, "Other"));
	await symlink(join(base, "Work Notes"), join(base, "link"));
	const work = await vaultIndexDir("/root", join(base, "Work Notes"));
	assert.match(work, /^\/root\/vaults\/Work-Notes-[0-9a-f]{16}$/);
	assert.equal(await vaultIndexDir("/root", join(base, "link")), work);
	assert.notEqual(await vaultIndexDir("/root", join(base, "Other")), work);
});

test("round-trips the index and leaves exactly one vectors file", async () => {
	const dir = join(await temp(), "vault");
	await writeIndex(dir, '{"first":true}', Float32Array.from([1, 2]));
	await writeIndex(dir, '{"second":true}', Float32Array.from([0.5, -1.25, 3]));
	const read = await readIndex(dir);
	assert.deepEqual([read?.meta, Array.from(read?.vectors ?? [])], ['{"second":true}', [0.5, -1.25, 3]]);
	assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith("vectors-")).length, 1);
});

test("returns no index for a missing or damaged pointer file", async () => {
	const dir = await temp();
	assert.equal(await readIndex(dir), null);
	await writeFile(join(dir, "index.json"), JSON.stringify({ vectors: "../escape.f32", meta: "{}" }));
	assert.equal(await readIndex(dir), null);
});

function fakeSpec(model: string, vocab: string): EncoderSpec {
	const sha = (s: string) => createHash("sha256").update(s).digest("hex");
	return {
		...E5_SMALL_V2,
		folderName: "fake-model",
		model: { name: "model.onnx", bytes: Buffer.byteLength(model), sha256: sha(model) },
		vocab: { name: "vocab.txt", bytes: Buffer.byteLength(vocab), sha256: sha(vocab) },
	};
}

test("imports a verified model folder into the local data folder", async () => {
	const source = await temp();
	const root = await temp();
	await writeFile(join(source, "model.onnx"), "MODEL");
	await writeFile(join(source, "vocab.txt"), "[PAD]\n[UNK]\n");
	const spec = fakeSpec("MODEL", "[PAD]\n[UNK]\n");
	const progress: number[] = [];
	assert.deepEqual(await importModel(source, root, spec, (done) => progress.push(done)), { ok: true });
	assert.equal(await readFile(join(installedModelDir(root, spec), "model.onnx"), "utf8"), "MODEL");
	assert.deepEqual(progress.at(-1), 17);
	const loaded = await loadInstalledModel(root, spec);
	assert.ok("vocab" in loaded);
	assert.equal(loaded.vocab, "[PAD]\n[UNK]\n");
	assert.deepEqual(await readdir(join(root, "models")), ["fake-model"]);
});

test("rejects a model file whose checksum does not match and installs nothing", async () => {
	const source = await temp();
	const root = await temp();
	await writeFile(join(source, "model.onnx"), "MODEX");
	await writeFile(join(source, "vocab.txt"), "[PAD]\n[UNK]\n");
	const spec = fakeSpec("MODEL", "[PAD]\n[UNK]\n");
	assert.deepEqual(await importModel(source, root, spec, () => {}), { ok: false, message: "model.onnx does not match the published SHA-256 checksum" });
	assert.deepEqual(await readdir(join(root, "models")), []);
	assert.deepEqual(await loadInstalledModel(root, spec), { ok: false, message: `model.onnx is missing from ${installedModelDir(root, spec)}` });
});
