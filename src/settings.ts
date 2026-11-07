import type { IntegrityReport } from "./compare";

export interface IntegritySettings {
	/** Random id generated once per device; names the manifest object. */
	deviceId: string;
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
	lastRunAt: number;
	lastReport: IntegrityReport | null;
	/** Mismatch keys already shown, so a notice fires only for new ones. */
	knownMismatchKeys: string[];
}

export const DEFAULT_SETTINGS: IntegritySettings = {
	deviceId: "",
	deviceName: "",
	scheduleEnabled: true,
	intervalHours: 6,
	quietMinutes: 10,
	graceMinutes: 30,
	excludePatterns: [],
	notifyOnNewMismatch: true,
	lastRunAt: 0,
	lastReport: null,
	knownMismatchKeys: [],
};

export function generateDeviceId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
