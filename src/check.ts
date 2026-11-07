/** One integrity run: publish the local manifest, fetch the others, compare. */
import type { App } from "obsidian";
import { compareManifests, type IntegrityReport } from "./compare";
import { deriveHashKey } from "./crypto/manifest-crypto";
import type { LiveSyncCredentials } from "./livesync-credentials";
import {
	buildManifest,
	deviceIdFromKey,
	manifestKey,
	MANIFEST_FOLDER,
	parseManifest,
	serializeManifest,
	type Manifest,
} from "./manifest";
import { S3Client, type RequestFn } from "./s3/client";

/** A manifest object larger than this is not downloaded. */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** More manifests than this are not compared; the rest is reported. */
export const MAX_MANIFESTS = 64;

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

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

	options.onProgress?.("Listing manifests");
	const folder = `${creds.bucketPrefix}${MANIFEST_FOLDER}`;
	const listing = await client.list(folder);
	if (listing.malformed > 0) {
		report.errors.push(
			`${listing.malformed} listing entr${listing.malformed === 1 ? "y" : "ies"} could not be read`,
		);
	}
	const candidates = listing.objects
		.map((object) => ({
			object,
			deviceId: deviceIdFromKey(creds.bucketPrefix, object.key),
		}))
		.filter(
			(c): c is { object: typeof c.object; deviceId: string } =>
				c.deviceId !== undefined && c.deviceId !== options.deviceId,
		)
		.sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
	const ignored = listing.objects.length - candidates.length - 1;
	if (ignored > 0) {
		report.errors.push(
			`${ignored} object(s) under ${MANIFEST_FOLDER} are not manifests and were ignored`,
		);
	}
	if (candidates.length > MAX_MANIFESTS) {
		report.errors.push(
			`${candidates.length} other manifests found; only the first ${MAX_MANIFESTS} were compared`,
		);
		candidates.length = MAX_MANIFESTS;
	}

	const seen = new Set<string>();
	for (const { object, deviceId } of candidates) {
		seen.add(deviceId);
		options.onProgress?.(`Comparing with ${deviceId}`);
		if (object.size > MAX_MANIFEST_BYTES) {
			report.errors.push(
				`${deviceId}: manifest is ${object.size} bytes, above the ${MAX_MANIFEST_BYTES} byte limit`,
			);
			continue;
		}
		let remote: Manifest;
		try {
			remote = await parseManifest(
				await client.get(object.key, MAX_MANIFEST_BYTES),
				creds.passphrase,
				deviceId,
			);
		} catch (error) {
			report.errors.push(`${deviceId}: ${describe(error)}`);
			continue;
		}
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
		if (!seen.has(deviceId)) {
			report.errors.push(
				`${deviceId}: manifest seen before has disappeared from the bucket`,
			);
		}
	}
	report.devices.sort((a, b) => a.manifestAgeMs - b.manifestAgeMs);
	return report;
}
