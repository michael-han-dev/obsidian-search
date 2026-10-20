import { type CachedMetadata, FileSystemAdapter, getAllTags, Notice, parseFrontMatterAliases, Plugin, type TAbstractFile, TFile } from "obsidian";
import { E5_SMALL_V2 } from "../core/encoder-spec.ts";
import { noteMetadata } from "../core/metadata.ts";
import { parseQuery } from "../core/query.ts";
import { type NoteMetadata, type SearchOutcome, type SourceFile, VAULT_COLLECTION } from "../core/types.ts";
import { EngineClient, type EngineStatus } from "./engine-client.ts";
import { importModel, loadInstalledModel } from "./model-files.ts";
import { DowseSettingTab } from "./settings.ts";
import { dataRoot, deleteAllLocalData, readIndex, vaultIndexDir, writeIndex } from "./storage.ts";
import { DowseView, VIEW_TYPE } from "./view.ts";

const SYNC_DELAY_MS = 300;
const SYNC_MAX_DELAY_MS = 2000;
const RECONCILE_MIN_MS = 30_000;

const stamp = (file: TFile) => `${file.stat.mtime}:${file.stat.size}`;

// Obsidian's parse, not ours, so tags match native Search.
function metadataOf(cache: CachedMetadata | null): NoteMetadata {
	return noteMetadata({
		aliases: parseFrontMatterAliases(cache?.frontmatter ?? null) ?? [],
		tags: (cache && getAllTags(cache)) ?? [],
		frontmatter: cache?.frontmatter ?? {},
	});
}

export default class DowsePlugin extends Plugin {
	readonly root = dataRoot();
	private client: EngineClient | null = null;
	private indexDir: string | null = null;
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
		this.addRibbonIcon("telescope", "Open Dowse concept search", () => void this.activateView());
		this.addSettingTab(new DowseSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => void this.start());
	}

	override async onunload(): Promise<void> {
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		this.flushTimer = null;
		this.dirty.clear();
		this.statusListeners.clear();
		const client = this.client;
		this.client = null;
		await client?.dispose();
	}

	get status(): EngineStatus | null {
		return this.client?.status ?? null;
	}

	get canImport(): boolean {
		return this.client !== null;
	}

	onStatus(listener: (status: EngineStatus) => void): () => void {
		this.statusListeners.add(listener);
		if (this.client) listener(this.client.status);
		return () => this.statusListeners.delete(listener);
	}

	search(text: string, limit: number): Promise<SearchOutcome | null> {
		const parsed = parseQuery(text);
		if (parsed.ok) return this.client?.search(parsed.query, limit) ?? Promise.resolve(null);
		this.client?.cancel();
		return Promise.resolve({ kind: "invalid", error: parsed.error });
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
		const indexDir = this.indexDir;
		const client = new EngineClient({ onSnapshot: (meta, vectors) => void writeIndex(indexDir, meta, vectors) });
		this.client = client;
		client.onStatus((status) => {
			for (const listener of this.statusListeners) listener(status);
		});
		const saved = await readIndex(indexDir);
		if (saved) client.post({ type: "restore", meta: saved.meta, vectors: saved.vectors }, [saved.vectors.buffer]);
		await this.loadModel();
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
		this.serial(() => this.syncAll());
	}

	private async loadModel(): Promise<boolean> {
		const installed = await loadInstalledModel(this.root, E5_SMALL_V2);
		if (!("model" in installed) || !this.client) return false;
		this.client.post({ type: "load-model", model: installed.model, vocab: installed.vocab }, [installed.model.buffer]);
		return true;
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

	async importModelFrom(folder: string, onProgress: (done: number, total: number) => void): Promise<string | null> {
		const result = await importModel(folder, this.root, E5_SMALL_V2, onProgress);
		if (!result.ok) return result.message;
		await this.loadModel();
		return null;
	}

	async deleteLocalData(): Promise<void> {
		await this.client?.dispose();
		this.client = null;
		await deleteAllLocalData(this.root);
		new Notice("Dowse deleted its local index and model files. Restart the plugin to start over.");
	}
}
