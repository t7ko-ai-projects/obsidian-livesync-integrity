import { type App, Modal } from "obsidian";
import type { DeviceReport, IntegrityReport } from "../compare";
import { mismatchCount } from "../compare";

export function formatAge(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) {
		return "just now";
	}
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 48) {
		return `${hours} h ago`;
	}
	return `${Math.round(hours / 24)} days ago`;
}

export class ReportModal extends Modal {
	constructor(
		app: App,
		private readonly report: IntegrityReport | null,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("Integrity report");
		if (!this.report) {
			contentEl.createEl("p", {
				text: "No check has run yet. Run the integrity check first.",
			});
			return;
		}
		const r = this.report;
		const total = mismatchCount(r);
		contentEl.createEl("p", {
			text: `Checked ${formatAge(Date.now() - r.createdAt)}: ${r.localFileCount} local files, ${r.devices.length} other device(s), ${total} mismatch(es).`,
			cls: total > 0 ? "t7li-bad" : undefined,
		});
		if (r.devices.length === 0) {
			contentEl.createEl("p", {
				text: "No other device has published a manifest, so nothing was compared. Install the plugin on the other devices and let it run once; if it already ran there, its manifest is missing from the bucket.",
				cls: "t7li-bad",
			});
		}
		for (const device of r.devices) {
			this.renderDevice(contentEl, device);
		}
		if (r.errors.length > 0) {
			const section = contentEl.createDiv({ cls: "t7li-report-section" });
			section.createEl("h3", { text: "Problems" });
			const list = section.createEl("ul", { cls: "t7li-report-list" });
			for (const error of r.errors) {
				list.createEl("li", { text: error, cls: "t7li-bad" });
			}
		}
	}

	private renderDevice(parent: HTMLElement, device: DeviceReport): void {
		const section = parent.createDiv({ cls: "t7li-report-section" });
		const label = device.deviceName
			? `${device.deviceName} (${device.deviceId})`
			: device.deviceId;
		section.createEl("h3", { text: label });
		section.createEl("div", {
			text:
				`Manifest from ${formatAge(device.manifestAgeMs)}; ${device.pending} file(s) still inside the grace window.` +
				(device.stale
					? " Stale: that device has not checked for a long time, so these results compare against an old snapshot."
					: ""),
			cls: device.stale ? "t7li-bad" : "t7li-muted",
		});
		const groups: [string, string[]][] = [
			["Different content", device.differing],
			["Only on this device", device.onlyHere],
			["Only on that device", device.onlyThere],
		];
		let any = false;
		for (const [title, paths] of groups) {
			if (paths.length === 0) {
				continue;
			}
			any = true;
			section.createEl("div", { text: `${title} (${paths.length})` });
			const list = section.createEl("ul", { cls: "t7li-report-list" });
			for (const path of paths) {
				list.createEl("li", { text: path });
			}
		}
		if (!any) {
			section.createEl("div", { text: "No mismatches." });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
