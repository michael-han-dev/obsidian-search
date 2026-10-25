import { type CachedMetadata, FileSystemAdapter, getAllTags, parseFrontMatterAliases, Plugin, type TAbstractFile, TFile } from "obsidian";
import { ENCODER } from "../core/encoder-spec.ts";
import { noteMetadata } from "../core/metadata.ts";
import { parseQuery } from "../core/query.ts";
import { type NoteMetadata, type SearchOutcome, type SourceFile, VAULT_COLLECTION } from "../core/types.ts";
import { EngineClient, type EngineStatus } from "./engine-client.ts";
import { type AbortReason, acquireModel, hasInstalledFiles, loadInstalledModel, type ModelSource } from "./model-files.ts";
import { DowseSettingTab } from "./settings.ts";
import { SetupModal } from "./setup.ts";
import { dataRoot, deleteAllLocalData, readIndex, vaultIndexDir, writeIndex } from "./storage.ts";
import { DowseView, VIEW_TYPE } from "./view.ts";

const SYNC_DELAY_MS = 300;
const SYNC_MAX_DELAY_MS = 2000;
const RECONCILE_MIN_MS = 30_000;
const IDLE_RELEASE_MS = 300_000;
const PROGRESS_EVERY_MS = 100;

const stamp = (file: TFile) => `${file.stat.mtime}:${file.stat.size}`;

// Obsidian's parse, not ours, so tags match native Search.
function metadataOf(cache: CachedMetadata | null): NoteMetadata {
	return noteMetadata({
		aliases: parseFrontMatterAliases(cache?.frontmatter ?? null) ?? [],
		tags: (cache && getAllTags(cache)) ?? [],
		frontmatter: cache?.frontmatter ?? {},
	});
}

type Setup =
	| { readonly kind: "idle" }
	| { readonly kind: "acquiring"; readonly source: ModelSource; readonly doneBytes: number; readonly totalBytes: number; readonly controller: AbortController }
	| { readonly kind: "checking" }
	| { readonly kind: "failed"; readonly source: ModelSource; readonly message: string };

export default class DowsePlugin extends Plugin {
	readonly root = dataRoot();
	readonly download: ModelSource = { kind: "download", baseUrl: process.env.DOWSE_MODEL_BASE_URL ?? "https://huggingface.co" };
	readonly idleMs = Number(process.env.DOWSE_IDLE_MS) || IDLE_RELEASE_MS;
	private client: EngineClient | null = null;
	private indexDir: string | null = null;
	private setup: Setup = { kind: "checking" };
	private setupModal: SetupModal | null = null;
	private lastProgress = 0;
	private readonly statusListeners = new Set<(status: EngineStatus) => void>();
	private readonly dirty = new Set<string>();
	private dirtySince = 0;
	private flushTimer: number | null = null;
	private readonly sent = new Map<string, string>();
	private lastReconcile = 0;
	private syncing: Promise<void> = Promise.resolve();

	override async onload(): Promise<void> {
		this.registerView(VIEW_TYPE, (leaf) => new DowseView(leaf, this));
		this.addCommand({ id: "open-search", name: "Open concept search", callback: () => void this.activateView() });
		this.addCommand({ id: "set-up", name: "Set up concept search", callback: () => this.openSetup() });
		this.addRibbonIcon("telescope", "Open Dowse concept search", () => void this.activateView());
		this.addSettingTab(new DowseSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => void this.start());
	}

	override async onunload(): Promise<void> {
		if (this.setup.kind === "acquiring") this.setup.controller.abort("unload" satisfies AbortReason);
		this.setupModal?.close();
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		this.flushTimer = null;
		this.dirty.clear();
		this.statusListeners.clear();
		const client = this.client;
		this.client = null;
		await client?.dispose();
	}

	get status(): EngineStatus | null {
		const base = this.client?.status;
		if (!base) return null;
		const setup = this.setup;
		if (setup.kind === "acquiring") return { ...base, model: { kind: "acquiring", doneBytes: setup.doneBytes, totalBytes: setup.totalBytes } };
		if (base.model.kind !== "model-needed") return base;
		if (setup.kind === "checking") return { ...base, model: { kind: "loading" } };
		if (setup.kind === "failed") return { ...base, model: { kind: "failed", message: setup.message, retry: "acquire" } };
		return base;
	}

	get canSetUp(): boolean {
		return this.client !== null;
	}

	onStatus(listener: (status: EngineStatus) => void): () => void {
		this.statusListeners.add(listener);
		const status = this.status;
		if (status) listener(status);
		return () => this.statusListeners.delete(listener);
	}

	private emit(): void {
		const status = this.status;
		if (status) for (const listener of this.statusListeners) listener(status);
	}

	private setSetup(setup: Setup): void {
		this.setup = setup;
		this.emit();
	}

	search(text: string, limit: number): Promise<SearchOutcome | null> {
		const parsed = parseQuery(text);
		if (parsed.ok) return this.client?.search(parsed.query, limit) ?? Promise.resolve(null);
		this.client?.cancel();
		return Promise.resolve({ kind: "invalid", error: parsed.error });
	}

	openSetup(): void {
		if (this.setupModal) return;
		this.setupModal = new SetupModal(this.app, this, () => (this.setupModal = null));
		this.setupModal.open();
	}

	async activateView(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		await leaf.loadIfDeferred();
		if (leaf.view instanceof DowseView) leaf.view.focusInput();
	}

	private async start(): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return;
		this.indexDir = await vaultIndexDir(this.root, adapter.getBasePath());
		// "changed" carries Obsidian's parse of the new text, so there is no modify handler.
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.touch(file.path)));
		this.registerEvent(this.app.vault.on("create", (file) => this.touchAll(file, file.path)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.touchAll(file, file.path)));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.touchAll(file, oldPath);
				this.touchAll(file, file.path);
			}),
		);
		this.registerDomEvent(window, "focus", () => this.reconcile());
		await this.startEngine();
	}

	private async startEngine(): Promise<void> {
		const indexDir = this.indexDir;
		if (!indexDir) return;
		const client = new EngineClient({ onSnapshot: (meta, vectors) => void writeIndex(indexDir, meta, vectors), onNeedModel: () => void this.loadModel() });
		this.client = client;
		client.onStatus((status) => {
			if (this.setup.kind === "checking" && status.model.kind !== "model-needed") this.setup = { kind: "idle" };
			this.emit();
		});
		const saved = await readIndex(indexDir);
		if (saved) client.post({ type: "restore", meta: saved.meta, vectors: saved.vectors }, [saved.vectors.buffer]);
		this.serial(() => this.syncAll());
		await this.loadModel();
	}

	private async restartEngine(): Promise<void> {
		const client = this.client;
		this.client = null;
		await client?.dispose();
		await this.startEngine();
	}

	private async loadModel(): Promise<void> {
		const client = this.client;
		if (!client) return;
		const installed = await loadInstalledModel(this.root, ENCODER);
		if (client !== this.client) return;
		if ("model" in installed) {
			client.post({ type: "load-model", model: installed.model, vocab: installed.vocab, idleMs: this.idleMs }, [installed.model.buffer]);
			return;
		}
		client.post({ type: "model-unavailable" });
		if (await hasInstalledFiles(this.root, ENCODER)) {
			this.setSetup({ kind: "failed", source: this.download, message: `The model files on this computer did not pass verification: ${installed.message}. Set up again to replace them.` });
		} else if (this.setup.kind === "checking") {
			this.setSetup({ kind: "idle" });
		}
	}

	async acquire(source: ModelSource): Promise<void> {
		if (this.setup.kind === "acquiring" || !this.client) return;
		const controller = new AbortController();
		const totalBytes = ENCODER.model.bytes + ENCODER.vocab.bytes;
		this.setSetup({ kind: "acquiring", source, doneBytes: 0, totalBytes, controller });
		const result = await acquireModel(source, this.root, ENCODER, controller.signal, (doneBytes) => {
			const setup = this.setup;
			if (setup.kind !== "acquiring" || !this.acquiringWith(controller)) return;
			this.setup = { ...setup, doneBytes };
			if (Date.now() - this.lastProgress < PROGRESS_EVERY_MS && doneBytes < totalBytes) return;
			this.lastProgress = Date.now();
			this.emit();
		});
		if (!this.acquiringWith(controller)) return;
		if (result.kind === "installed") {
			this.setSetup({ kind: "checking" });
			await this.loadModel();
		} else if (result.kind === "cancelled") {
			this.setSetup({ kind: "idle" });
		} else {
			this.setSetup({ kind: "failed", source, message: result.message });
		}
	}

	private acquiringWith(controller: AbortController): boolean {
		return this.setup.kind === "acquiring" && this.setup.controller === controller;
	}

	cancelSetup(): void {
		if (this.setup.kind === "acquiring") this.setup.controller.abort("cancel" satisfies AbortReason);
	}

	async retry(): Promise<void> {
		const model = this.status?.model;
		if (model?.kind !== "failed") return;
		switch (model.retry) {
			case "acquire":
				return this.acquire(this.setup.kind === "failed" ? this.setup.source : this.download);
			case "load":
				return this.loadModel();
			case "restart":
				return this.restartEngine();
			default: {
				const unhandled: never = model.retry;
				return unhandled;
			}
		}
	}

	private async readSource(file: TFile): Promise<{ source: SourceFile; stamp: string }> {
		const stampAtRead = stamp(file);
		const text = await this.app.vault.cachedRead(file);
		return { source: { collectionId: VAULT_COLLECTION, path: file.path, text, metadata: metadataOf(this.app.metadataCache.getFileCache(file)) }, stamp: stampAtRead };
	}

	// Serial, so a slow read never posts older text after newer text.
	private serial(operation: () => Promise<void>): void {
		this.syncing = this.syncing.then(operation).catch((error: unknown) => console.error("Dowse sync failed", error));
	}

	private async syncAll(): Promise<void> {
		this.sent.clear();
		this.lastReconcile = Date.now();
		const read = await Promise.allSettled(this.app.vault.getMarkdownFiles().map((file) => this.readSource(file)));
		const posted = read.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
		this.client?.post({ type: "sync", files: posted.map((r) => r.source), removed: [], complete: true });
		for (const r of posted) this.sent.set(r.source.path, r.stamp);
	}

	private touch(path: string): void {
		if (!path.toLowerCase().endsWith(".md")) return;
		if (this.dirty.size === 0) this.dirtySince = Date.now();
		this.dirty.add(path);
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		const wait = Math.max(0, Math.min(SYNC_DELAY_MS, this.dirtySince + SYNC_MAX_DELAY_MS - Date.now()));
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			this.serial(() => this.flush());
		}, wait);
	}

	private touchAll(file: TAbstractFile, path: string): void {
		if (file instanceof TFile) return this.touch(path);
		const prefix = `${path}/`;
		for (const known of this.sent.keys()) if (known.startsWith(prefix)) this.touch(known);
		for (const current of this.app.vault.getMarkdownFiles()) if (current.path.startsWith(prefix)) this.touch(current.path);
	}

	private async flush(): Promise<void> {
		const paths = [...this.dirty];
		this.dirty.clear();
		const removed: string[] = [];
		const read: { source: SourceFile; stamp: string }[] = [];
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && file.extension === "md") {
				try {
					read.push(await this.readSource(file));
				} catch {
					this.dirty.add(path);
				}
			} else removed.push(path);
		}
		for (const path of removed) this.sent.delete(path);
		this.client?.post({ type: "sync", files: read.map((r) => r.source), removed, complete: false });
		for (const r of read) this.sent.set(r.source.path, r.stamp);
	}

	private reconcile(): void {
		if (!this.client || Date.now() - this.lastReconcile < RECONCILE_MIN_MS) return;
		this.lastReconcile = Date.now();
		const present = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			present.add(file.path);
			if (this.sent.get(file.path) !== stamp(file)) this.touch(file.path);
		}
		for (const path of this.sent.keys()) if (!present.has(path)) this.touch(path);
	}

	async deleteLocalData(): Promise<void> {
		this.cancelSetup();
		const client = this.client;
		this.client = null;
		await client?.dispose();
		await deleteAllLocalData(this.root);
		this.setup = { kind: "checking" };
	}
}
