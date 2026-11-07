/** The manifest one device publishes: a keyed hash, size and mtime per file. */
import type { App, TFile } from "obsidian";
import { fromUtf8, utf8 } from "./bytes";
import {
	decryptBytes,
	encryptBytes,
	hashFile,
	ManifestFormatError,
} from "./crypto/manifest-crypto";

export const MANIFEST_FORMAT = "t7-livesync-integrity/1";
/** Folder under LiveSync's bucket prefix. The underscore keeps LiveSync's
 * journal receiver away from it (it skips keys starting with "_"). */
export const MANIFEST_FOLDER = "_integrity/";

export interface ManifestEntry {
	/** HMAC-SHA256 of the content, hex. */
	h: string;
	/** Size in bytes. */
	s: number;
	/** Modification time, ms since the epoch. */
	m: number;
}

export interface Manifest {
	format: typeof MANIFEST_FORMAT;
	deviceId: string;
	deviceName: string;
	createdAt: number;
	files: Record<string, ManifestEntry>;
}

export function manifestKey(bucketPrefix: string, deviceId: string): string {
	return `${bucketPrefix}${MANIFEST_FOLDER}${deviceId}.json`;
}

/** Compile the user's exclusion patterns; invalid ones are reported, not used. */
export function compileExclusions(patterns: string[]): {
	regexes: RegExp[];
	invalid: string[];
} {
	const regexes: RegExp[] = [];
	const invalid: string[] = [];
	for (const pattern of patterns) {
		const trimmed = pattern.trim();
		if (!trimmed) {
			continue;
		}
		try {
			regexes.push(new RegExp(trimmed));
		} catch {
			invalid.push(trimmed);
		}
	}
	return { regexes, invalid };
}

export function isExcluded(path: string, regexes: RegExp[]): boolean {
	return regexes.some((r) => r.test(path));
}

export interface ManifestBuildOptions {
	deviceId: string;
	deviceName: string;
	exclusions: RegExp[];
	hashKey: CryptoKey;
	now?: number;
	/** Called after every file, so the UI can show progress. */
	onProgress?: (done: number, total: number) => void;
}

/** Hash every non-excluded vault file. Reads only; never writes. */
export async function buildManifest(
	app: App,
	options: ManifestBuildOptions,
): Promise<Manifest> {
	const files = app.vault
		.getFiles()
		.filter((f: TFile) => !isExcluded(f.path, options.exclusions))
		.sort((a, b) => (a.path < b.path ? -1 : 1));
	const entries: Record<string, ManifestEntry> = {};
	let done = 0;
	for (const file of files) {
		const content = await app.vault.readBinary(file);
		entries[file.path] = {
			h: await hashFile(options.hashKey, content),
			s: file.stat.size,
			m: file.stat.mtime,
		};
		done += 1;
		options.onProgress?.(done, files.length);
	}
	return {
		format: MANIFEST_FORMAT,
		deviceId: options.deviceId,
		deviceName: options.deviceName,
		createdAt: options.now ?? Date.now(),
		files: entries,
	};
}

export async function serializeManifest(
	manifest: Manifest,
	passphrase: string,
): Promise<Uint8Array> {
	return encryptBytes(passphrase, utf8(JSON.stringify(manifest)));
}

function isEntry(value: unknown): value is ManifestEntry {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const e = value as Record<string, unknown>;
	return (
		typeof e.h === "string" &&
		typeof e.s === "number" &&
		typeof e.m === "number"
	);
}

export async function parseManifest(
	container: Uint8Array,
	passphrase: string,
): Promise<Manifest> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			fromUtf8(await decryptBytes(passphrase, container)),
		);
	} catch (error) {
		if (error instanceof ManifestFormatError) {
			throw error;
		}
		throw new ManifestFormatError("manifest is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new ManifestFormatError("manifest is not an object");
	}
	const m = parsed as Record<string, unknown>;
	if (m.format !== MANIFEST_FORMAT) {
		throw new ManifestFormatError(
			`unknown manifest format ${String(m.format)}`,
		);
	}
	if (
		typeof m.deviceId !== "string" ||
		typeof m.deviceName !== "string" ||
		typeof m.createdAt !== "number" ||
		typeof m.files !== "object" ||
		m.files === null
	) {
		throw new ManifestFormatError("manifest has missing fields");
	}
	for (const entry of Object.values(m.files as Record<string, unknown>)) {
		if (!isEntry(entry)) {
			throw new ManifestFormatError(
				"manifest has a malformed file entry",
			);
		}
	}
	return parsed as Manifest;
}
