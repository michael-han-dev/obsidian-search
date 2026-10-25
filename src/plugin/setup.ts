import { type App, Modal, Setting } from "obsidian";
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

export class SetupModal extends Modal {
	private readonly plugin: DowsePlugin;
	private readonly onClosed: () => void;
	private stateEl!: HTMLElement;
	private folder = "";
	private unsubscribe: (() => void) | null = null;

	constructor(app: App, plugin: DowsePlugin, onClosed: () => void) {
		super(app);
		this.plugin = plugin;
		this.onClosed = onClosed;
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Set up concept search");
		contentEl.addClass("dowse-setup");
		contentEl.createEl("p", { text: "Dowse finds notes by meaning with a small language model that runs on this computer. Your notes and searches never leave it." });
		const facts = contentEl.createEl("dl", { cls: "dowse-facts" });
		const fact = (term: string, detail: string) => {
			facts.createEl("dt", { text: term });
			facts.createEl("dd", { text: detail });
		};
		fact("Model", `${ENCODER.id}, ${ENCODER.license} license, revision ${ENCODER.revision.slice(0, 7)}`);
		fact("Download", `${mb(ENCODER.model.bytes + ENCODER.vocab.bytes)} MB from huggingface.co, once. Dowse checks every file against its published SHA-256 checksum before using it.`);
		fact("Disk", `${mb(ENCODER.model.bytes + ENCODER.vocab.bytes)} MB for the model, plus about ${MODEL_FACTS.indexMbPer1000Notes} MB of index per 1,000 notes.`);
		fact("Memory", `About ${MODEL_FACTS.memoryMb} MB while the model is loaded, up to ${MODEL_FACTS.peakMemoryMb} MB during the first indexing. Dowse frees it after ${Math.round(this.plugin.idleMs / 60_000)} minutes without searching or indexing.`);
		fact("Location", `${this.plugin.root}, outside your vault. Nothing there syncs with the vault.`);
		fact("Network", "Only this download. Searching and indexing work offline afterwards.");
		this.stateEl = contentEl.createDiv({ cls: "dowse-setup-state" });
		this.unsubscribe = this.plugin.onStatus((status) => this.render(status));
		if (!this.plugin.status) this.stateEl.setText("Dowse is starting. Open this screen again in a moment.");
	}

	override onClose(): void {
		this.unsubscribe?.();
		this.contentEl.empty();
		this.onClosed();
	}

	private render(status: EngineStatus): void {
		const el = this.stateEl;
		el.empty();
		const { model, coverage } = status;
		const label = conceptLabel(model, coverage);
		el.dataset.label = label;
		const line = (text: string, cls = "dowse-setup-line") => el.createEl("p", { text, cls });
		switch (model.kind) {
			case "model-needed":
				new Setting(el)
					.setName("Download the model")
					.setDesc(`${mb(ENCODER.model.bytes + ENCODER.vocab.bytes)} MB from huggingface.co.`)
					.addButton((b) => b.setButtonText("Download and set up").setCta().setDisabled(!this.plugin.canSetUp).onClick(() => void this.plugin.acquire(this.plugin.download)));
				this.renderImport(el);
				return;
			case "acquiring":
				el.createEl("progress", { cls: "dowse-progress", attr: { max: String(model.totalBytes), value: String(model.doneBytes) } });
				line(`Getting the model: ${mb(model.doneBytes)} of ${mb(model.totalBytes)} MB.`);
				new Setting(el).addButton((b) => b.setButtonText("Cancel").onClick(() => this.plugin.cancelSetup()));
				return;
			case "loading":
				line("Loading the model…");
				return;
			case "loaded":
			case "released":
				line(
					label === "indexing"
						? `Indexing your notes: ${coverage.embeddedSources} of ${coverage.totalSources} searchable. You can search the indexed notes now.`
						: `Concept search is ready. ${coverage.totalSources} notes searchable.`,
				);
				new Setting(el).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
				return;
			case "failed":
				line(model.message, "dowse-setup-line dowse-error");
				new Setting(el).addButton((b) => b.setButtonText("Retry").setCta().onClick(() => void this.plugin.retry()));
				if (model.retry === "acquire") this.renderImport(el);
				return;
			case "disabled":
				line("Concept search is disabled.");
				return;
			default: {
				const unhandled: never = model;
				return unhandled;
			}
		}
	}

	private renderImport(el: HTMLElement): void {
		new Setting(el)
			.setName("Or import from a folder")
			.setDesc(`A folder holding ${ENCODER.model.name} and ${ENCODER.vocab.name} from ${ENCODER.id} at revision ${ENCODER.revision.slice(0, 7)}. Dowse checks both against the same checksums.`)
			.addText((text) => text.setPlaceholder("/path/to/model folder").setValue(this.folder).onChange((value) => (this.folder = value.trim())))
			.addButton((b) => b.setButtonText("Import").setDisabled(!this.plugin.canSetUp).onClick(() => void this.plugin.acquire({ kind: "folder", dir: this.folder })));
	}
}
