import { FileSystemAdapter, getFrontMatterInfo, Notice, parseFrontMatterAliases, parseYaml, Plugin, type TAbstractFile, TFile } from "obsidian";
import { E5_SMALL_V2 } from "../core/encoder-spec.ts";
import { type SearchResponse, type SourceFile, VAULT_COLLECTION } from "../core/types.ts";
import { EngineClient, type EngineStatus } from "./engine-client.ts";
import { importModel, loadInstalledModel } from "./model-files.ts";
import { DowseSettingTab } from "./settings.ts";
import { dataRoot, deleteAllLocalData, readIndex, vaultIndexDir, writeIndex } from "./storage.ts";
import { DowseView, VIEW_TYPE } from "./view.ts";

const SYNC_DELAY_MS = 300;

function aliasesFrom(text: string): string[] {
	const info = getFrontMatterInfo(text);
	if (!info.exists) return [];
	try {
		return parseFrontMatterAliases(parseYaml(info.frontmatter)) ?? [];
	} catch {
		return [];
	}
}

export default class DowsePlugin extends Plugin {
	readonly root = dataRoot();
	private client: EngineClient | null = null;
	private indexDir: string | null = null;
	private readonly statusListeners = new Set<(status: EngineStatus) => void>();
	private readonly syncTimers = new Map<string, number>();

	override async onload(): Promise<void> {
		this.registerView(VIEW_TYPE, (leaf) => new DowseView(leaf, this));
		this.addCommand({ id: "open-search", name: "Open concept search", callback: () => void this.activateView() });
		this.addRibbonIcon("telescope", "Open Dowse concept search", () => void this.activateView());
		this.addSettingTab(new DowseSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => void this.start());
	}

	override async onunload(): Promise<void> {
		for (const timer of this.syncTimers.values()) window.clearTimeout(timer);
		this.syncTimers.clear();
		this.statusListeners.clear();
		const client = this.client;
		this.client = null;
		await client?.dispose();
	}

	get status(): EngineStatus | null {
		return this.client?.status ?? null;
	}

	onStatus(listener: (status: EngineStatus) => void): () => void {
		this.statusListeners.add(listener);
		if (this.client) listener(this.client.status);
		return () => this.statusListeners.delete(listener);
	}

	search(text: string, limit: number): Promise<SearchResponse | null> {
		return this.client?.search(text, limit) ?? Promise.resolve(null);
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
		await this.syncAll();
		this.registerEvent(this.app.vault.on("create", (file) => this.queueSync(file)));
		this.registerEvent(this.app.vault.on("modify", (file) => this.queueSync(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.client?.post({ type: "remove", paths: [file.path] })));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.client?.post({ type: "remove", paths: [oldPath] });
				this.queueSync(file);
			}),
		);
	}

	private async loadModel(): Promise<boolean> {
		const installed = await loadInstalledModel(this.root, E5_SMALL_V2);
		if (!("model" in installed) || !this.client) return false;
		this.client.post({ type: "load-model", model: installed.model, vocab: installed.vocab }, [installed.model.buffer]);
		return true;
	}

	private async readSource(file: TFile): Promise<SourceFile> {
		const text = await this.app.vault.cachedRead(file);
		return { collectionId: VAULT_COLLECTION, path: file.path, text, aliases: aliasesFrom(text) };
	}

	private async syncAll(): Promise<void> {
		const files = await Promise.all(this.app.vault.getMarkdownFiles().map((file) => this.readSource(file)));
		this.client?.post({ type: "sync", files, complete: true });
	}

	private queueSync(file: TAbstractFile): void {
		if (!(file instanceof TFile) || file.extension !== "md") return;
		const existing = this.syncTimers.get(file.path);
		if (existing !== undefined) window.clearTimeout(existing);
		this.syncTimers.set(
			file.path,
			window.setTimeout(async () => {
				this.syncTimers.delete(file.path);
				const current = this.app.vault.getAbstractFileByPath(file.path);
				if (current instanceof TFile) this.client?.post({ type: "sync", files: [await this.readSource(current)], complete: false });
			}, SYNC_DELAY_MS),
		);
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
