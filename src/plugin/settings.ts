import { type App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import { E5_SMALL_V2 } from "../core/encoder-spec.ts";
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
	private folder = "";

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
			.setName("Candidate encoder")
			.setDesc(`${E5_SMALL_V2.id} at revision ${E5_SMALL_V2.revision.slice(0, 7)}, ${E5_SMALL_V2.license} license, ${Math.round(E5_SMALL_V2.model.bytes / 1e6)} MB. Status: ${label}.`);
		const importSetting = new Setting(containerEl)
			.setName("Import from folder")
			.setDesc(`A folder containing ${E5_SMALL_V2.model.name} and ${E5_SMALL_V2.vocab.name}. Dowse checks both files against their published checksums before using them.`)
			.addText((text) => text.setPlaceholder("/path/to/e5-small-v2").setValue(this.folder).onChange((value) => (this.folder = value.trim())));
		importSetting.addButton((button) =>
			button.setButtonText("Import").onClick(async () => {
				button.setDisabled(true);
				const error = await this.plugin.importModelFrom(this.folder, (done, total) => button.setButtonText(`${Math.round((100 * done) / total)}%`));
				button.setDisabled(false).setButtonText("Import");
				new Notice(error ?? "Model imported. Dowse is loading it now.");
				this.display();
			}),
		);

		new Setting(containerEl).setName("Local data").setHeading();
		new Setting(containerEl)
			.setName("Storage folder")
			.setDesc(`Dowse keeps its index and model in ${this.plugin.root}, outside your vault. Nothing here syncs with the vault. Removing the plugin does not delete this folder.`)
			.addButton((button) =>
				button
					.setButtonText("Delete local data")
					.setWarning()
					.onClick(() => new ConfirmDelete(this.app, () => void this.plugin.deleteLocalData().then(() => this.display())).open()),
			);
	}
}
