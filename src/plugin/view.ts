import { ItemView, MarkdownView, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import { digest } from "../core/hash.ts";
import { type ConceptLabel, conceptLabel, type FileResult, type SearchResponse } from "../core/types.ts";
import type { EngineStatus } from "./engine-client.ts";
import type DowsePlugin from "./main.ts";

export const VIEW_TYPE = "dowse-search";
const PAUSE_MS = 150;
const RESULT_LIMIT = 20;

const LABEL_TEXT: Record<ConceptLabel, string> = {
	"model-needed": "Concept search needs a model. Import it in Dowse settings.",
	acquiring: "Importing the model…",
	loading: "Loading the model…",
	indexing: "Indexing notes…",
	ready: "Ready.",
	failed: "Concept search failed.",
	disabled: "Concept search is disabled.",
};

export class DowseView extends ItemView {
	private readonly plugin: DowsePlugin;
	private input!: HTMLInputElement;
	private statusEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private timer: number | null = null;
	private files: readonly FileResult[] = [];
	private selected = -1;
	private lastLabel: ConceptLabel | null = null;
	private lastInputAt = 0;
	private unsubscribe: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: DowsePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Dowse";
	}

	override getIcon(): string {
		return "telescope";
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("dowse-view");
		this.input = root.createEl("input", { type: "search", cls: "dowse-input", attr: { placeholder: "Search by meaning", "aria-label": "Search by meaning" } });
		this.statusEl = root.createDiv({ cls: "dowse-status" });
		this.resultsEl = root.createDiv({ cls: "dowse-results" });
		this.registerDomEvent(this.input, "input", (event) => this.schedule(event.timeStamp));
		this.registerDomEvent(this.input, "keydown", (event) => this.onKey(event));
		this.unsubscribe = this.plugin.onStatus((status) => this.showStatus(status));
	}

	override async onClose(): Promise<void> {
		this.unsubscribe?.();
		if (this.timer !== null) window.clearTimeout(this.timer);
	}

	focusInput(): void {
		this.input.focus();
		this.input.select();
	}

	private schedule(inputAt: number): void {
		this.lastInputAt = inputAt;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.run(), PAUSE_MS);
	}

	private async run(): Promise<void> {
		this.timer = null;
		const inputAt = this.lastInputAt;
		const response = await this.plugin.search(this.input.value, RESULT_LIMIT);
		if (response) this.render(response, inputAt);
	}

	private showStatus(status: EngineStatus): void {
		const label = conceptLabel(status.model, status.coverage);
		const { embeddedSources, totalSources } = status.coverage;
		const detail = status.model.kind === "failed" ? ` ${status.model.message}` : "";
		const coverage = label === "indexing" || label === "ready" ? ` ${embeddedSources} of ${totalSources} notes searchable.` : "";
		this.statusEl.setText(LABEL_TEXT[label] + detail + coverage);
		this.statusEl.dataset.label = label;
		const becameSearchable = (label === "ready" || label === "indexing") && this.lastLabel !== label;
		this.lastLabel = label;
		if (becameSearchable && this.input.value.trim() !== "") void this.run();
	}

	private render(response: SearchResponse, inputAt: number): void {
		this.resultsEl.empty();
		this.files = response.kind === "results" ? response.files : [];
		this.selected = this.files.length > 0 ? 0 : -1;
		if (response.kind === "results" && this.files.length === 0) this.resultsEl.createDiv({ cls: "dowse-empty", text: "No matching notes yet." });
		this.files.forEach((file, index) => {
			const row = this.resultsEl.createDiv({ cls: "dowse-result", attr: { "data-path": file.path } });
			row.createDiv({ cls: "dowse-title", text: file.title });
			row.createDiv({ cls: "dowse-path", text: file.path });
			const best = file.passages[0];
			if (best) {
				if (best.headingPath.length > 0) row.createDiv({ cls: "dowse-heading", text: best.headingPath.join(" › ") });
				row.createDiv({ cls: "dowse-passage", text: best.text });
			}
			this.registerDomEvent(row, "click", () => void this.openResult(index));
		});
		this.highlight();
		this.resultsEl.dataset.generation = String(response.generation);
		this.resultsEl.dataset.kind = response.kind;
		window.requestAnimationFrame(() => {
			this.resultsEl.dataset.latencyMs = (performance.now() - inputAt).toFixed(1);
			if (response.kind === "results") this.resultsEl.dataset.embedMs = response.timings.embedMs.toFixed(1);
		});
	}

	private highlight(): void {
		Array.from(this.resultsEl.children).forEach((el, i) => el.toggleClass("is-selected", i === this.selected));
	}

	private onKey(event: KeyboardEvent): void {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			if (this.files.length === 0) return;
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			this.selected = (this.selected + step + this.files.length) % this.files.length;
			this.highlight();
			this.resultsEl.children[this.selected]?.scrollIntoView({ block: "nearest" });
		} else if (event.key === "Enter" && this.selected >= 0) {
			event.preventDefault();
			void this.openResult(this.selected);
		}
	}

	private async openResult(index: number): Promise<void> {
		const result = this.files[index];
		const file = result && this.app.vault.getAbstractFileByPath(result.path);
		if (!result || !(file instanceof TFile)) {
			new Notice("This note no longer exists.");
			return;
		}
		const current = await digest(await this.app.vault.cachedRead(file));
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		const best = result.passages[0];
		if (current !== result.revision || !best) {
			if (current !== result.revision) new Notice("This note changed since it was indexed, so it opened at the top.");
			return;
		}
		if (leaf.view instanceof MarkdownView) {
			const from = { line: best.span.start.line - 1, ch: best.span.start.column };
			leaf.view.editor.setCursor(from);
			leaf.view.editor.scrollIntoView({ from, to: { line: best.span.end.line - 1, ch: best.span.end.column } }, true);
		}
	}
}
