import { type App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import { ENCODER } from "../core/encoder-spec.ts";
import { conceptLabel } from "../core/types.ts";
import type DowsePlugin from "./main.ts";

class ConfirmDelete extends Modal {
	private readonly onConfirm: () => void;

	constructor(app: App, onConfirm: () => void) {
		super(app);
		this.onConfirm = onConfirm;
	}

	override onOpen(): void {
		this.setTitle("Delete local Dowse data?");
		this.contentEl.createEl("p", { text: "This removes the index and model files on this computer. Your notes are not touched." });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Delete")
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}
}

export class DowseSettingTab extends PluginSettingTab {
	private readonly plugin: DowsePlugin;

	constructor(app: App, plugin: DowsePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const status = this.plugin.status;
		const label = status ? conceptLabel(status.model, status.coverage) : "loading";

		new Setting(containerEl).setName("Model").setHeading();
		new Setting(containerEl)
			.setName("Concept search model")
			.setDesc(`${ENCODER.id} at revision ${ENCODER.revision.slice(0, 7)}, ${ENCODER.license} license, ${Math.round((ENCODER.model.bytes + ENCODER.vocab.bytes) / 1e6)} MB. Status: ${label}.`)
			.addButton((b) =>
				b
					.setButtonText(label === "model-needed" || label === "failed" ? "Set up concept search" : "Show setup")
					.setDisabled(!this.plugin.canSetUp)
					.onClick(() => this.plugin.openSetup()),
			);

		new Setting(containerEl).setName("Local data").setHeading();
		new Setting(containerEl)
			.setName("Storage folder")
			.setDesc(`Dowse keeps its index and model in ${this.plugin.root}, outside your vault. Nothing here syncs with the vault. Removing the plugin does not delete this folder.`)
			.addButton((button) =>
				button
					.setButtonText("Delete local data")
					.setWarning()
					.onClick(() =>
						new ConfirmDelete(this.app, () =>
							void this.plugin.deleteLocalData().then(() => {
								new Notice("Dowse deleted its local index and model files. Restart the plugin to start over.");
								this.display();
							}),
						).open(),
					),
			);
	}
}
