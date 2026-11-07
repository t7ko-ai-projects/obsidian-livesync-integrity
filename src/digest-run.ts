/**
 * One digest run: scan the vault with the same keyed hash as the check,
 * read the other devices' manifests for attribution (nothing is uploaded),
 * and diff against the baseline.
 */
import type { App } from "obsidian";
import { deriveHashKey } from "./crypto/manifest-crypto";
import { computeDigest, type DigestBaseline, type DigestEntry } from "./digest";
import type { LiveSyncCredentials } from "./livesync-credentials";
import { buildManifest, type Manifest } from "./manifest";
import { fetchRemoteManifests } from "./remote-manifests";
import { S3Client, type RequestFn } from "./s3/client";

export interface DigestRunOptions {
	deviceId: string;
	exclusions: RegExp[];
	baseline: DigestBaseline | null;
	now?: number;
	request?: RequestFn;
	onProgress?: (message: string) => void;
}

export interface DigestResult {
	/** Null on the first run, when there was no baseline to diff against. */
	entries: DigestEntry[] | null;
	/** The scan to save as the next baseline. */
	baseline: DigestBaseline;
	/** Why attribution may be incomplete: unreadable manifests and the like. */
	notes: string[];
}

export async function runDigest(
	app: App,
	creds: LiveSyncCredentials,
	options: DigestRunOptions,
): Promise<DigestResult> {
	const now = options.now ?? Date.now();
	const hashKey = await deriveHashKey(creds.passphrase);
	options.onProgress?.("Hashing vault files");
	const scan = await buildManifest(app, {
		deviceId: options.deviceId,
		deviceName: "",
		exclusions: options.exclusions,
		hashKey,
		now,
	});
	const baseline: DigestBaseline = { savedAt: now, files: scan.files };
	if (options.baseline === null) {
		return { entries: null, baseline, notes: [] };
	}
	let remotes: Manifest[] = [];
	const notes: string[] = [];
	try {
		const fetched = await fetchRemoteManifests(
			new S3Client(creds, options.request),
			creds,
			options.deviceId,
			options.onProgress,
		);
		remotes = fetched.manifests;
		notes.push(...fetched.errors);
	} catch (error) {
		notes.push(
			`Other devices' manifests could not be read, so changes are not attributed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		entries: computeDigest(options.baseline, scan.files, remotes),
		baseline,
		notes,
	};
}
