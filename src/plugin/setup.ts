import { homedir } from "node:os";
import { type App, Modal, setIcon, setTooltip } from "obsidian";
import { ENCODER } from "../core/encoder-spec.ts";
import { conceptLabel } from "../core/types.ts";
import type { EngineStatus } from "./engine-client.ts";
import type DowsePlugin from "./main.ts";

// Measured on the 1,000-note pilot; see dev-assets/m3/resource-manifest.json.
export const MODEL_FACTS = {
	memoryMb: 470,
	peakMemoryMb: 810,
	indexMbPer1000Notes: 11,
} as const;

const mb = (bytes: number) => Math.round(bytes / 1e6);
const DOWNLOAD_MB = mb(ENCODER.model.bytes + ENCODER.vocab.bytes);
const REVISION = ENCODER.revision.slice(0, 7);

type Tone = "todo" | "active" | "done" | "error";

interface Action {
	readonly text: string;
	readonly run: () => void;
	readonly needsEngine?: boolean;
}

interface StateView {
	readonly status: { readonly text: string; readonly tone: Tone; readonly fill?: number };
	readonly line?: string;
	readonly error?: boolean;
	readonly progress?: { readonly value: number; readonly max: number; readonly detail: string };
	readonly importFolder?: boolean;
	readonly note?: string;
	readonly secondary?: Action;
	readonly primary?: Action;
}

export class SetupModal extends Modal {
	private readonly plugin: DowsePlugin;
	private readonly onClosed: () => void;
	private statusEl!: HTMLElement;
	private stateEl!: HTMLElement;
	private folder = "";
	private importInput: HTMLInputElement | null = null;
	private primary: Action | null = null;
	private primaryButton: HTMLButtonElement | null = null;
	// Progress arrives every 100 ms; rebuilding would replace a button under the pointer mid-click.
	private shape = "";
	private live: { icon?: HTMLElement; line?: HTMLElement; progress?: HTMLProgressElement; detail?: HTMLElement } = {};
	private unsubscribe: (() => void) | null = null;

	constructor(app: App, plugin: DowsePlugin, onClosed: () => void) {
		super(app);
		this.plugin = plugin;
		this.onClosed = onClosed;
	}

	override onOpen(): void {
		this.modalEl.addClass("dowse-setup-modal");
		const { contentEl } = this;
		contentEl.addClass("dowse-setup");

		const header = contentEl.createDiv({ cls: "dowse-setup-header" });
		const crumbs = header.createDiv({ cls: "dowse-crumbs" });
		setIcon(crumbs.createSpan({ cls: "dowse-crumb-icon" }), "telescope");
		crumbs.createSpan({ text: "Dowse" });
		crumbs.createSpan({ cls: "dowse-crumb-separator", text: "›" });
		crumbs.createSpan({ text: "Concept search" });
		header.createEl("h2", { cls: "dowse-setup-title", text: "Set up concept search" });
		header.createEl("p", { cls: "dowse-setup-lede", text: "Find notes by meaning with a small model that runs on this computer. Your notes and searches never leave it." });

		const facts = contentEl.createDiv({ cls: "dowse-facts" });
		const fact = (icon: string, term: string): HTMLElement => {
			const row = facts.createDiv({ cls: "dowse-fact" });
			const label = row.createDiv({ cls: "dowse-fact-label" });
			setIcon(label.createSpan({ cls: "dowse-fact-icon" }), icon);
			label.createSpan({ text: term });
			return row.createDiv({ cls: "dowse-fact-value" });
		};
		const describe = (el: HTMLElement, value: string, meta: string, cls = "dowse-fact-main") => {
			el.createSpan({ cls, text: value });
			el.createSpan({ cls: "dowse-fact-meta", text: meta });
		};
		this.statusEl = fact("activity", "Status");
		describe(fact("box", "Model"), ENCODER.id, `${ENCODER.license} license · ${REVISION}`);
		describe(fact("download", "Download"), `${DOWNLOAD_MB} MB from huggingface.co, once`, "SHA-256 checked");
		describe(fact("hard-drive", "Disk"), `${DOWNLOAD_MB} MB`, `+ about ${MODEL_FACTS.indexMbPer1000Notes} MB per 1,000 notes`);
		describe(fact("cpu", "Memory"), `${MODEL_FACTS.memoryMb} MB loaded, ${MODEL_FACTS.peakMemoryMb} MB peak`, `freed after ${Math.round(this.plugin.idleMs / 60_000)} idle min`);
		const location = fact("folder", "Location");
		describe(location, this.plugin.root.replace(homedir(), "~"), "outside your vault", "dowse-fact-main dowse-fact-path");
		setTooltip(location, this.plugin.root);
		describe(fact("globe", "Network"), "Only this download", "search runs offline");

		this.stateEl = contentEl.createDiv({ cls: "dowse-setup-state" });
		this.scope.register([], "Enter", () => {
			if (document.activeElement instanceof HTMLButtonElement) return;
			if (this.folder !== "" && document.activeElement === this.importInput) this.importFolder();
			else this.primary?.run();
			return false;
		});
		this.unsubscribe = this.plugin.onStatus((status) => this.render(status));
		if (!this.plugin.status) this.render(null);
	}

	// Obsidian focuses the first text field on open, which would put the import field ahead of the download.
	override open(): void {
		super.open();
		this.primaryButton?.focus();
	}

	override onClose(): void {
		this.unsubscribe?.();
		this.contentEl.empty();
		this.onClosed();
	}

	private view(status: EngineStatus | null): StateView {
		if (!status) return { status: { text: "Starting", tone: "todo" }, line: "Dowse is starting. Open this screen again in a moment." };
		const { model, coverage } = status;
		const done = { text: "Done", run: () => this.close() };
		switch (model.kind) {
			case "model-needed":
				return {
					status: { text: "Not set up", tone: "todo" },
					importFolder: true,
					note: `${DOWNLOAD_MB} MB, one time`,
					primary: { text: "Download and set up", run: () => void this.plugin.acquire(this.plugin.download), needsEngine: true },
				};
			case "acquiring":
				return {
					status: { text: "Downloading", tone: "active", fill: model.doneBytes / model.totalBytes },
					line: `Getting the model: ${mb(model.doneBytes)} of ${mb(model.totalBytes)} MB.`,
					progress: { value: model.doneBytes, max: model.totalBytes, detail: `${Math.floor((100 * model.doneBytes) / model.totalBytes)}%` },
					secondary: { text: "Cancel", run: () => this.plugin.cancelSetup() },
				};
			case "loading":
				return { status: { text: "Loading", tone: "active", fill: 0.5 }, line: "Loading the model…" };
			case "loaded":
			case "released":
				if (conceptLabel(model, coverage) === "indexing") {
					return {
						status: { text: "Indexing", tone: "active", fill: coverage.embeddedSources / coverage.totalSources },
						line: `Indexing your notes: ${coverage.embeddedSources} of ${coverage.totalSources} searchable. You can search the indexed notes now.`,
						progress: { value: coverage.embeddedSources, max: coverage.totalSources, detail: `${coverage.embeddedSources} of ${coverage.totalSources}` },
						primary: done,
					};
				}
				return { status: { text: "Ready", tone: "done" }, line: `Concept search is ready. ${coverage.totalSources} notes searchable.`, primary: done };
			case "failed":
				return {
					status: { text: "Failed", tone: "error" },
					line: model.message,
					error: true,
					importFolder: model.retry === "acquire",
					primary: { text: "Retry", run: () => void this.plugin.retry() },
				};
			case "disabled":
				return { status: { text: "Disabled", tone: "todo" }, line: "Concept search is disabled." };
			default: {
				const unhandled: never = model;
				return unhandled;
			}
		}
	}

	private render(status: EngineStatus | null): void {
		const view = this.view(status);
		const shape = JSON.stringify([view.status.text, view.status.tone, !!view.line, view.error, !!view.progress, view.importFolder, view.note, view.primary?.text, view.secondary?.text]);
		if (shape !== this.shape) {
			this.shape = shape;
			this.build(view);
		}
		this.stateEl.dataset.label = status ? conceptLabel(status.model, status.coverage) : "";
		this.live.icon?.setCssProps({ "--dowse-fill": `${Math.round(100 * (view.status.fill ?? 0))}%` });
		if (view.line) this.live.line?.setText(view.line);
		if (view.progress && this.live.progress && this.live.detail) {
			this.live.progress.max = view.progress.max;
			this.live.progress.value = view.progress.value;
			this.live.detail.setText(view.progress.detail);
		}
	}

	private build(view: StateView): void {
		this.statusEl.empty();
		const chip = this.statusEl.createSpan({ cls: "dowse-chip" });
		const icon = chip.createSpan({ cls: "dowse-status-icon", attr: { "data-tone": view.status.tone } });
		if (view.status.tone === "done") setIcon(icon, "check");
		if (view.status.tone === "error") setIcon(icon, "x");
		chip.createSpan({ text: view.status.text });
		this.live = { icon };

		const el = this.stateEl;
		el.empty();
		this.importInput = null;
		if (view.line) {
			const body = el.createDiv({ cls: view.error ? "dowse-setup-body dowse-callout" : "dowse-setup-body" });
			if (view.error) setIcon(body.createSpan({ cls: "dowse-callout-icon" }), "alert-circle");
			const text = body.createDiv({ cls: "dowse-setup-text" });
			this.live.line = text.createEl("p", { cls: view.error ? "dowse-setup-line dowse-error" : "dowse-setup-line" });
			if (view.progress) {
				const bar = text.createDiv({ cls: "dowse-bar" });
				this.live.progress = bar.createEl("progress", { cls: "dowse-progress" });
				this.live.detail = bar.createSpan({ cls: "dowse-bar-detail" });
			}
		}
		if (view.importFolder) this.buildImport(el);
		const footer = el.createDiv({ cls: "dowse-setup-footer" });
		footer.createSpan({ cls: "dowse-footer-note", text: view.note ?? "" });
		const actions = footer.createDiv({ cls: "dowse-footer-actions" });
		if (view.secondary) this.button(actions, view.secondary);
		this.primaryButton = view.primary ? this.button(actions, view.primary, true) : null;
		this.primaryButton?.createSpan({ cls: "dowse-kbd", text: "↵" });
		this.primary = view.primary ?? null;
		if (!this.contentEl.contains(document.activeElement)) this.primaryButton?.focus();
	}

	private importFolder(): void {
		void this.plugin.acquire({ kind: "folder", dir: this.folder });
	}

	private buildImport(el: HTMLElement): void {
		const section = el.createDiv({ cls: "dowse-import" });
		const label = section.createDiv({ cls: "dowse-import-label" });
		label.createSpan({ text: "Import from a folder" });
		label.createSpan({ cls: "dowse-import-hint", text: `${ENCODER.model.name} and ${ENCODER.vocab.name} from revision ${REVISION}, checked the same way` });
		const row = section.createDiv({ cls: "dowse-import-row" });
		const input = row.createEl("input", { type: "text", cls: "dowse-input-field", attr: { placeholder: "/path/to/model folder", spellcheck: "false" } });
		input.value = this.folder;
		input.addEventListener("input", () => (this.folder = input.value.trim()));
		this.importInput = input;
		this.button(row, { text: "Import", run: () => this.importFolder(), needsEngine: true });
	}

	private button(parent: HTMLElement, action: Action, primary = false): HTMLButtonElement {
		const button = parent.createEl("button", { cls: primary ? "dowse-button mod-cta" : "dowse-button", text: action.text });
		button.disabled = !!action.needsEngine && !this.plugin.canSetUp;
		button.addEventListener("click", () => action.run());
		return button;
	}
}
