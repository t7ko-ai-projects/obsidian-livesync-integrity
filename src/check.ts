/** One integrity run: publish the local manifest, fetch the others, compare. */
import type { App } from "obsidian";
import { compareManifests, type IntegrityReport } from "./compare";
import { deriveHashKey } from "./crypto/manifest-crypto";
import type { LiveSyncCredentials } from "./livesync-credentials";
import { buildManifest, manifestKey, serializeManifest } from "./manifest";
import { fetchRemoteManifests } from "./remote-manifests";
import { S3Client, type RequestFn } from "./s3/client";

export { MAX_MANIFEST_BYTES, MAX_MANIFESTS } from "./remote-manifests";

export interface CheckOptions {
	deviceId: string;
	deviceName: string;
	exclusions: RegExp[];
	graceMs: number;
	/** A remote manifest older than this is marked stale. */
	staleMs?: number;
	/** Newest manifest time seen per device in earlier checks. A device that
	 * vanished or went backwards is reported. */
	previouslySeen?: Record<string, number>;
	now?: number;
	request?: RequestFn;
	onProgress?: (message: string) => void;
}

export async function runIntegrityCheck(
	app: App,
	creds: LiveSyncCredentials,
	options: CheckOptions,
): Promise<IntegrityReport> {
	const now = options.now ?? Date.now();
	const client = new S3Client(creds, options.request);
	const hashKey = await deriveHashKey(creds.passphrase);
	options.onProgress?.("Hashing vault files");
	const local = await buildManifest(app, {
		deviceId: options.deviceId,
		deviceName: options.deviceName,
		exclusions: options.exclusions,
		hashKey,
		now,
	});
	const report: IntegrityReport = {
		createdAt: now,
		localFileCount: Object.keys(local.files).length,
		devices: [],
		errors: [],
	};

	options.onProgress?.("Uploading manifest");
	const ownKey = manifestKey(creds.bucketPrefix, options.deviceId);
	await client.put(ownKey, await serializeManifest(local, creds.passphrase));

	const remotes = await fetchRemoteManifests(
		client,
		creds,
		options.deviceId,
		options.onProgress,
	);
	report.errors.push(...remotes.errors);

	for (const remote of remotes.manifests) {
		const deviceId = remote.deviceId;
		options.onProgress?.(`Comparing with ${deviceId}`);
		const before = options.previouslySeen?.[deviceId];
		if (before !== undefined && remote.createdAt < before) {
			report.errors.push(
				`${deviceId}: manifest went backwards in time (was ${new Date(before).toISOString()}, now ${new Date(remote.createdAt).toISOString()}); someone restored an old copy`,
			);
		}
		const device = compareManifests(local, remote, {
			now,
			graceMs: options.graceMs,
			staleMs: options.staleMs,
		});
		if (device.stale) {
			report.errors.push(
				`${deviceId}: manifest is ${Math.round(device.manifestAgeMs / 3_600_000)} h old; that device has not checked for a long time`,
			);
		}
		report.devices.push(device);
	}
	for (const deviceId of Object.keys(options.previouslySeen ?? {})) {
		if (!remotes.listed.has(deviceId)) {
			report.errors.push(
				`${deviceId}: manifest seen before has disappeared from the bucket`,
			);
		}
	}
	report.devices.sort((a, b) => a.manifestAgeMs - b.manifestAgeMs);
	return report;
}
