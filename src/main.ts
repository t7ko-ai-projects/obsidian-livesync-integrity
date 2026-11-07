import { Notice, Plugin } from "obsidian";
import { runIntegrityCheck } from "./check";
import {
	hasProblems,
	mismatchCount,
	mismatchKeys,
	type IntegrityReport,
} from "./compare";
import { readLiveSyncCredentials } from "./livesync-credentials";
import { compileExclusions, isValidDeviceId } from "./manifest";
import { isRunDue } from "./schedule";
import {
	DEFAULT_SETTINGS,
	DEVICE_ID_STORAGE_KEY,
	generateDeviceId,
	type IntegritySettings,
} from "./settings";
import { ReportModal } from "./ui/report-modal";
import { IntegritySettingTab } from "./ui/settings-tab";

const TICK_MS = 60_000;
const MINUTE = 60_000;
/** A remote manifest older than this many intervals is stale. */
const STALE_INTERVALS = 3;

/** Never hash the configuration folder, whatever the user's patterns say. */
function configFolderPattern(configDir: string): RegExp {
	const escaped = configDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}/`);
}

export default class LiveSyncIntegrityPlugin extends Plugin {
	settings: IntegritySettings = { ...DEFAULT_SETTINGS };
	/** Device-local (Obsidian local storage), never in data.json. */
	deviceId = "";
	private statusBar: HTMLElement | null = null;
	private running = false;
	/** Last vault change; plugin load counts as one, so startup sync settles. */
	private lastChangeAt = Date.now();
	/** Failure text of the last scheduled run, shown once until it changes. */
	private lastScheduledFailure = "";

	async onload(): Promise<void> {
		await this.loadSettings();
		this.deviceId = this.loadDeviceId();
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
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Read the device id from local storage; regenerate anything invalid. */
	private loadDeviceId(): string {
		const stored: unknown = this.app.loadLocalStorage(
			DEVICE_ID_STORAGE_KEY,
		);
		if (isValidDeviceId(stored)) {
			return stored;
		}
		const fresh = generateDeviceId();
		this.app.saveLocalStorage(DEVICE_ID_STORAGE_KEY, fresh);
		return fresh;
	}

	/** Scheduled run when due, backed off after failures, and the vault quiet. */
	private async tick(): Promise<void> {
		const s = this.settings;
		if (!s.scheduleEnabled || this.running) {
			return;
		}
		if (isRunDue({ ...s, lastChangeAt: this.lastChangeAt }, Date.now())) {
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
		this.settings.lastAttemptAt = Date.now();
		await this.saveSettings();
		this.setStatus("Integrity: running");
		const progress = manual
			? new Notice("Integrity check: starting", 0)
			: null;
		try {
			const intervalMs = this.settings.intervalHours * 60 * MINUTE;
			const report = await runIntegrityCheck(this.app, creds.creds, {
				deviceId: this.deviceId,
				deviceName: this.settings.deviceName,
				exclusions: regexes,
				graceMs: this.settings.graceMinutes * MINUTE,
				staleMs: STALE_INTERVALS * intervalMs,
				previouslySeen: this.settings.seenManifests,
				onProgress: (message) =>
					progress?.setMessage(`Integrity check: ${message}`),
			});
			this.lastScheduledFailure = "";
			await this.storeReport(report, manual);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			if (manual || message !== this.lastScheduledFailure) {
				new Notice(`Integrity check failed: ${message}`, 10_000);
			}
			if (!manual) {
				this.lastScheduledFailure = message;
			}
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
		for (const device of report.devices) {
			const before = s.seenManifests[device.deviceId] ?? 0;
			s.seenManifests[device.deviceId] = Math.max(
				before,
				device.manifestCreatedAt,
			);
		}
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

	/** Clear the rollback memory, e.g. after a device was retired. */
	async forgetDevices(): Promise<void> {
		this.settings.seenManifests = {};
		await this.saveSettings();
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
		const problems = hasProblems(report) ? ", problems" : "";
		if (total > 0) {
			this.setStatus(`Integrity: ${total} mismatches${problems}`);
		} else if (report.devices.length === 0) {
			this.setStatus(`Integrity: no other device${problems}`);
		} else {
			this.setStatus(
				`Integrity: OK (${report.devices.length} devices${problems})`,
			);
		}
	}
}
