import type { IntegrityReport } from "./compare";

/**
 * Settings kept in data.json. The device id is NOT here: data.json can be
 * copied between devices by LiveSync's customisation sync, and two devices
 * with one id would each filter out the other's manifest.
 */
export interface IntegritySettings {
	deviceName: string;
	scheduleEnabled: boolean;
	intervalHours: number;
	/** The vault must be unchanged for this long before a scheduled run. */
	quietMinutes: number;
	/** Files changed within this window are not reported yet. */
	graceMinutes: number;
	/** Regexes tested against vault paths; a match excludes the file. The
	 * vault's configuration folder is always excluded. */
	excludePatterns: string[];
	notifyOnNewMismatch: boolean;
	/** Start of the last successful run. */
	lastRunAt: number;
	/** Start of the last run, successful or not; failed runs back off. */
	lastAttemptAt: number;
	lastReport: IntegrityReport | null;
	/** Mismatch keys already shown, so a notice fires only for new ones. */
	knownMismatchKeys: string[];
	/** Newest manifest time seen per other device, to notice rollbacks. */
	seenManifests: Record<string, number>;
}

export const DEFAULT_SETTINGS: IntegritySettings = {
	deviceName: "",
	scheduleEnabled: true,
	intervalHours: 6,
	quietMinutes: 10,
	graceMinutes: 30,
	excludePatterns: [],
	notifyOnNewMismatch: true,
	lastRunAt: 0,
	lastAttemptAt: 0,
	lastReport: null,
	knownMismatchKeys: [],
	seenManifests: {},
};

/** Key in Obsidian's device-local storage that holds this device's id. */
export const DEVICE_ID_STORAGE_KEY = "t7-livesync-integrity:device-id";

export function generateDeviceId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
