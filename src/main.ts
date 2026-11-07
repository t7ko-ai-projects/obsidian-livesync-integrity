import { Notice, Plugin } from "obsidian";
import { runIntegrityCheck } from "./check";
import { mismatchCount, mismatchKeys, type IntegrityReport } from "./compare";
import { readLiveSyncCredentials } from "./livesync-credentials";
import { compileExclusions } from "./manifest";
import {
	DEFAULT_SETTINGS,
	generateDeviceId,
	type IntegritySettings,
} from "./settings";
import { ReportModal } from "./ui/report-modal";
import { IntegritySettingTab } from "./ui/settings-tab";

const TICK_MS = 60_000;

/** Never hash the configuration folder, whatever the user's patterns say. */
function configFolderPattern(configDir: string): RegExp {
	const escaped = configDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}/`);
}
const MINUTE = 60_000;

export default class LiveSyncIntegrityPlugin extends Plugin {
	settings: IntegritySettings = { ...DEFAULT_SETTINGS };
	private statusBar: HTMLElement | null = null;
	private running = false;
	/** Last vault change; plugin load counts as one, so startup sync settles. */
	private lastChangeAt = Date.now();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.statusBar = this.addStatusBarItem();
		this.updateStatusBar();

		this.addCommand({
			id: "run-check",
			name: "Run integrity check now",
			callback: () => void this.runCheck(true),
		});
		this.addCommand({
			id: "show-report",
			name: "Show integrity report",
			callback: () => this.showReport(),
		});
		this.addSettingTab(new IntegritySettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			const touch = () => {
				this.lastChangeAt = Date.now();
			};
			this.registerEvent(this.app.vault.on("create", touch));
			this.registerEvent(this.app.vault.on("modify", touch));
			this.registerEvent(this.app.vault.on("delete", touch));
			this.registerEvent(this.app.vault.on("rename", touch));
			this.registerInterval(
				window.setInterval(() => void this.tick(), TICK_MS),
			);
		});
	}

	async loadSettings(): Promise<void> {
		const stored =
			(await this.loadData()) as Partial<IntegritySettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
		if (!this.settings.deviceId) {
			this.settings.deviceId = generateDeviceId();
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Scheduled run when due and the vault has been quiet long enough. */
	private async tick(): Promise<void> {
		const s = this.settings;
		if (!s.scheduleEnabled || this.running) {
			return;
		}
		const now = Date.now();
		const due = now - s.lastRunAt >= s.intervalHours * 60 * MINUTE;
		const quiet = now - this.lastChangeAt >= s.quietMinutes * MINUTE;
		if (due && quiet) {
			await this.runCheck(false);
		}
	}

	async runCheck(manual: boolean): Promise<void> {
		if (this.running) {
			if (manual) {
				new Notice("Integrity check is already running");
			}
			return;
		}
		const creds = readLiveSyncCredentials(this.app);
		if (!creds.ok) {
			if (manual) {
				new Notice(`Integrity check skipped: ${creds.reason}`, 10_000);
			}
			return;
		}
		const { regexes, invalid } = compileExclusions(
			this.settings.excludePatterns,
		);
		regexes.push(configFolderPattern(this.app.vault.configDir));
		if (invalid.length > 0 && manual) {
			new Notice(
				`Ignoring invalid exclusion pattern(s): ${invalid.join(", ")}`,
			);
		}
		this.running = true;
		this.setStatus("Integrity: running");
		const progress = manual
			? new Notice("Integrity check: starting", 0)
			: null;
		try {
			const report = await runIntegrityCheck(this.app, creds.creds, {
				deviceId: this.settings.deviceId,
				deviceName: this.settings.deviceName,
				exclusions: regexes,
				graceMs: this.settings.graceMinutes * MINUTE,
				onProgress: (message) =>
					progress?.setMessage(`Integrity check: ${message}`),
			});
			await this.storeReport(report, manual);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			new Notice(`Integrity check failed: ${message}`, 10_000);
			this.setStatus("Integrity: failed");
		} finally {
			progress?.hide();
			this.running = false;
		}
	}

	private async storeReport(
		report: IntegrityReport,
		manual: boolean,
	): Promise<void> {
		const s = this.settings;
		const keys = mismatchKeys(report);
		const known = new Set(s.knownMismatchKeys);
		const fresh = keys.filter((k) => !known.has(k));
		s.lastRunAt = report.createdAt;
		s.lastReport = report;
		s.knownMismatchKeys = keys;
		await this.saveSettings();
		this.updateStatusBar();
		const total = mismatchCount(report);
		if (manual) {
			new Notice(
				`Integrity check done: ${total} mismatch(es) across ${report.devices.length} other device(s)` +
					(report.errors.length
						? `, ${report.errors.length} problem(s)`
						: ""),
			);
		} else if (fresh.length > 0 && s.notifyOnNewMismatch) {
			new Notice(
				`LiveSync integrity: ${fresh.length} new mismatch(es). Open the integrity report.`,
				15_000,
			);
		}
	}

	showReport(): void {
		new ReportModal(this.app, this.settings.lastReport).open();
	}

	private setStatus(text: string): void {
		this.statusBar?.setText(text);
	}

	private updateStatusBar(): void {
		const report = this.settings.lastReport;
		if (!report) {
			this.setStatus("Integrity: not checked");
			return;
		}
		const total = mismatchCount(report);
		const problems = report.errors.length ? ", problems" : "";
		this.setStatus(
			total === 0
				? `Integrity: OK (${report.devices.length} devices${problems})`
				: `Integrity: ${total} mismatches${problems}`,
		);
	}
}
