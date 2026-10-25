import { ItemView, MarkdownView, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import { digest } from "../core/hash.ts";
import { parseQuery } from "../core/query.ts";
import { type ConceptLabel, conceptLabel, type Digest, type SearchOutcome, type TextSpan } from "../core/types.ts";
import type { EngineStatus } from "./engine-client.ts";
import type DowsePlugin from "./main.ts";

export const VIEW_TYPE = "dowse-search";
const PAUSE_MS = 150;
const RESULT_LIMIT = 20;

interface Row {
	readonly path: string;
	readonly title: string;
	readonly revision: Digest;
	readonly headingPath: readonly string[];
	readonly text: string | null;
	readonly span: TextSpan | null;
}

function rowsOf(outcome: SearchOutcome): Row[] {
	switch (outcome.kind) {
		case "results":
			return outcome.files.map(({ path, title, revision, passages: [best] }) => ({ path, title, revision, headingPath: best?.headingPath ?? [], text: best?.text ?? null, span: best?.span ?? null }));
		case "matching":
			return outcome.files.map(({ path, title, revision, evidence }) => ({ path, title, revision, headingPath: evidence?.headingPath ?? [], text: evidence?.text ?? null, span: evidence?.span ?? null }));
		case "empty":
		case "not-ready":
		case "invalid":
			return [];
		default: {
			const unhandled: never = outcome;
			return unhandled;
		}
	}
}

function summaryOf(outcome: SearchOutcome, shown: number): string | null {
	switch (outcome.kind) {
		case "invalid":
			return outcome.error;
		case "matching":
			return outcome.total === 0 ? "No notes match these filters." : `Matching files: ${outcome.total}${outcome.total > shown ? `, showing ${shown}` : ""}.`;
		case "results": {
			const { embeddedSources, totalSources } = outcome.coverage;
			if (totalSources === 0) return "No notes match these filters.";
			const partial = embeddedSources < totalSources ? ` Searched ${embeddedSources} of ${totalSources} notes; the rest are still indexing.` : "";
			return ((shown === 0 ? "No strong matches." : "") + partial).trim() || null;
		}
		case "empty":
		case "not-ready":
			return null;
		default: {
			const unhandled: never = outcome;
			return unhandled;
		}
	}
}

const LABEL_TEXT: Record<ConceptLabel, string> = {
	"model-needed": "Concept search needs a one-time model setup. Filters already work.",
	acquiring: "Getting the model…",
	loading: "Loading the model…",
	indexing: "Indexing notes…",
	ready: "Ready.",
	failed: "Concept search failed.",
	disabled: "Concept search is disabled.",
};

const ACTION_TEXT: Partial<Record<ConceptLabel, string>> = {
	"model-needed": "Set up concept search",
	acquiring: "Show progress",
	failed: "Retry",
};

export class DowseView extends ItemView {
	private readonly plugin: DowsePlugin;
	private input!: HTMLInputElement;
	private statusEl!: HTMLElement;
	private actionEl!: HTMLButtonElement;
	private summaryEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private timer: number | null = null;
	private rows: readonly Row[] = [];
	private rendered = 0;
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
		this.input = root.createEl("input", { type: "search", cls: "dowse-input", attr: { placeholder: "Search by meaning, or filter with tag:, path:, file:", "aria-label": "Search by meaning" } });
		this.statusEl = root.createDiv({ cls: "dowse-status" });
		this.actionEl = root.createEl("button", { cls: "dowse-action" });
		this.registerDomEvent(this.actionEl, "click", () => (this.lastLabel === "failed" ? void this.plugin.retry() : this.plugin.openSetup()));
		this.summaryEl = root.createDiv({ cls: "dowse-summary" });
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
		const parsed = parseQuery(this.input.value);
		const wait = parsed.ok && parsed.query.relevance === "" && parsed.query.constraints.length > 0 ? 0 : PAUSE_MS;
		this.timer = window.setTimeout(() => void this.run(), wait);
	}

	private async run(): Promise<void> {
		this.timer = null;
		const inputAt = this.lastInputAt;
		const text = this.input.value;
		const response = await this.plugin.search(text, RESULT_LIMIT);
		if (response) this.render(response, text, inputAt);
	}

	private showStatus(status: EngineStatus): void {
		const label = conceptLabel(status.model, status.coverage);
		const { embeddedSources, totalSources } = status.coverage;
		const detail = status.model.kind === "failed" ? ` ${status.model.message}` : status.model.kind === "acquiring" ? ` ${Math.round(status.model.doneBytes / 1e6)} of ${Math.round(status.model.totalBytes / 1e6)} MB.` : "";
		const coverage = label === "indexing" || label === "ready" ? ` ${embeddedSources} of ${totalSources} notes searchable.` : "";
		this.statusEl.setText(LABEL_TEXT[label] + detail + coverage);
		this.statusEl.dataset.label = label;
		const action = ACTION_TEXT[label];
		this.actionEl.setText(action ?? "");
		this.actionEl.toggle(action !== undefined);
		const becameSearchable = (label === "ready" || label === "indexing") && this.lastLabel !== label;
		this.lastLabel = label;
		if (becameSearchable && this.resultsEl.dataset.kind === "not-ready" && this.input.value.trim() !== "") void this.run();
	}

	private render(outcome: SearchOutcome, text: string, inputAt: number): void {
		this.resultsEl.empty();
		this.rows = rowsOf(outcome);
		this.selected = this.rows.length > 0 ? 0 : -1;
		const summary = summaryOf(outcome, this.rows.length);
		this.summaryEl.setText(summary ?? "");
		this.summaryEl.toggleClass("dowse-error", outcome.kind === "invalid");
		this.rows.forEach((row, index) => {
			const el = this.resultsEl.createDiv({ cls: "dowse-result", attr: { "data-path": row.path } });
			el.createDiv({ cls: "dowse-title", text: row.title });
			el.createDiv({ cls: "dowse-path", text: row.path });
			if (row.headingPath.length > 0) el.createDiv({ cls: "dowse-heading", text: row.headingPath.join(" › ") });
			if (row.text !== null) el.createDiv({ cls: "dowse-passage", text: row.text });
			el.addEventListener("click", () => void this.openResult(index));
		});
		this.highlight();
		this.resultsEl.dataset.generation = String(++this.rendered);
		this.resultsEl.dataset.kind = outcome.kind;
		this.resultsEl.dataset.query = text;
		delete this.resultsEl.dataset.latencyMs;
		window.requestAnimationFrame(() => {
			this.resultsEl.dataset.latencyMs = (performance.now() - inputAt).toFixed(1);
			this.resultsEl.dataset.embedMs = outcome.kind === "results" ? outcome.timings.embedMs.toFixed(1) : "0";
		});
	}

	private highlight(): void {
		Array.from(this.resultsEl.children).forEach((el, i) => el.toggleClass("is-selected", i === this.selected));
	}

	private onKey(event: KeyboardEvent): void {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			if (this.rows.length === 0) return;
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			this.selected = (this.selected + step + this.rows.length) % this.rows.length;
			this.highlight();
			this.resultsEl.children[this.selected]?.scrollIntoView({ block: "nearest" });
		} else if (event.key === "Enter" && this.selected >= 0) {
			event.preventDefault();
			void this.openResult(this.selected);
		}
	}

	private async openResult(index: number): Promise<void> {
		const row = this.rows[index];
		const file = row && this.app.vault.getAbstractFileByPath(row.path);
		if (!row || !(file instanceof TFile)) {
			new Notice("This note no longer exists.");
			return;
		}
		const current = await digest(await this.app.vault.cachedRead(file));
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		if (current !== row.revision) new Notice("This note changed since it was indexed, so it opened at the top.");
		if (current !== row.revision || !row.span || !(leaf.view instanceof MarkdownView)) return;
		const from = { line: row.span.start.line - 1, ch: row.span.start.column };
		leaf.view.editor.setCursor(from);
		leaf.view.editor.scrollIntoView({ from, to: { line: row.span.end.line - 1, ch: row.span.end.column } }, true);
	}
}
