import { type App, ButtonComponent, Modal, Notice, setTooltip } from "obsidian";
import { DIGEST_KINDS, digestGroup, type DigestEntry } from "../digest";

/** LiveSync command ids (checked against v1.0.45, commit 24a1bfc1). */
export const LIVESYNC_HISTORY_COMMAND = "obsidian-livesync:livesync-history";
export const LIVESYNC_FILE_HISTORY_COMMAND =
	"obsidian-livesync:livesync-filehistory";

const GROUP_TITLES: Record<DigestEntry["kind"], string> = {
	renamed: "Renamed or moved",
	added: "Added",
	modified: "Modified",
	deleted: "Deleted",
};

/** `app.commands` is an undocumented internal; probe it, never assume it. */
interface AppWithCommands {
	commands?: {
		executeCommandById?: (id: string) => boolean;
	};
}

export function runLiveSyncCommand(app: App, id: string): boolean {
	const commands = (app as unknown as AppWithCommands).commands;
	if (typeof commands?.executeCommandById !== "function") {
		return false;
	}
	try {
		return commands.executeCommandById(id);
	} catch {
		return false;
	}
}

export function formatSize(bytes: number): string {
	if (Math.abs(bytes) < 1024) {
		return `${bytes} B`;
	}
	if (Math.abs(bytes) < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDelta(delta: number): string {
	return (delta >= 0 ? "+" : "-") + formatSize(Math.abs(delta));
}

export function describeEntry(entry: DigestEntry): string {
	const parts: string[] = [];
	if (entry.kind === "modified" && entry.sizeDelta !== undefined) {
		parts.push(
			`${formatDelta(entry.sizeDelta)}, now ${formatSize(entry.size)}`,
		);
	} else {
		parts.push(formatSize(entry.size));
	}
	parts.push(new Date(entry.mtime).toLocaleString());
	if (entry.device) {
		parts.push(`from ${entry.device}`);
	}
	return parts.join(", ");
}

/** The digest itself; `notes` explain incomplete attribution. */
export class DigestModal extends Modal {
	constructor(
		app: App,
		private readonly entries: DigestEntry[],
		private readonly since: number,
		private readonly notes: string[],
		/** Saves the live scan as the baseline; closing without it keeps the
		 * old baseline so the same digest can be reopened. */
		private readonly onMarkSeen: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("Daily digest");
		contentEl.createEl("p", {
			text: `${this.entries.length} change(s) since ${new Date(this.since).toLocaleString()}. Click an entry to open the file and its LiveSync history. Closing keeps this digest; "Mark as seen" starts the next one from now.`,
			cls: "t7li-muted",
		});
		new ButtonComponent(contentEl.createDiv({ cls: "t7li-digest-actions" }))
			.setButtonText("Mark as seen")
			.setCta()
			.onClick(() => {
				this.close();
				void this.onMarkSeen();
			});
		if (this.entries.length === 0) {
			contentEl.createEl("p", { text: "No changes." });
		}
		for (const kind of DIGEST_KINDS) {
			const group = digestGroup(this.entries, kind);
			if (group.length === 0) {
				continue;
			}
			const section = contentEl.createDiv({ cls: "t7li-report-section" });
			section.createEl("h3", {
				text: `${GROUP_TITLES[kind]} (${group.length})`,
			});
			const list = section.createEl("ul", { cls: "t7li-report-list" });
			for (const entry of group) {
				this.renderEntry(list, entry);
			}
		}
		for (const note of this.notes) {
			contentEl.createEl("p", { text: note, cls: "t7li-bad" });
		}
	}

	private renderEntry(list: HTMLElement, entry: DigestEntry): void {
		const item = list.createEl("li");
		const link = item.createEl("a", {
			cls: "t7li-digest-entry",
			text:
				entry.kind === "renamed" && entry.oldPath !== undefined
					? `${entry.oldPath} -> ${entry.path}`
					: entry.path,
		});
		setTooltip(
			link,
			entry.kind === "deleted"
				? "Deleted files cannot be opened; this opens LiveSync's file history picker, where you pick the file yourself."
				: "Open the file and its LiveSync history",
		);
		item.createEl("div", { text: describeEntry(entry), cls: "t7li-muted" });
		link.addEventListener("click", (event) => {
			event.preventDefault();
			this.close();
			void this.openEntry(entry);
		});
	}

	private async openEntry(entry: DigestEntry): Promise<void> {
		if (entry.kind === "deleted") {
			if (!runLiveSyncCommand(this.app, LIVESYNC_FILE_HISTORY_COMMAND)) {
				new Notice(
					"Document history is unavailable (is the sync plugin running?); the file is deleted, so nothing can be opened.",
				);
			}
			return;
		}
		const file = this.app.vault.getFileByPath(entry.path);
		if (!file) {
			new Notice(`File not found: ${entry.path}`);
			return;
		}
		await this.app.workspace.getLeaf().openFile(file);
		if (!runLiveSyncCommand(this.app, LIVESYNC_HISTORY_COMMAND)) {
			new Notice(
				"Document history is unavailable (is the sync plugin running?); opened the file only.",
			);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Shown on the first run, when there was nothing to compare against. */
export class BaselineRecordedModal extends Modal {
	constructor(
		app: App,
		private readonly fileCount: number,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Daily digest");
		this.contentEl.empty();
		this.contentEl.createEl("p", {
			text: `Baseline recorded: ${this.fileCount} files. The next digest lists what changed since now.`,
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
