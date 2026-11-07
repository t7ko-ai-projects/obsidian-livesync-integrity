/** One integrity run: publish the local manifest, fetch the others, compare. */
import type { App } from "obsidian";
import { compareManifests, type IntegrityReport } from "./compare";
import { deriveHashKey } from "./crypto/manifest-crypto";
import type { LiveSyncCredentials } from "./livesync-credentials";
import {
	buildManifest,
	MANIFEST_FOLDER,
	manifestKey,
	parseManifest,
	serializeManifest,
	type Manifest,
} from "./manifest";
import { S3Client, type RequestFn } from "./s3/client";

export interface CheckOptions {
	deviceId: string;
	deviceName: string;
	exclusions: RegExp[];
	graceMs: number;
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
	const objects = (await client.list(folder)).filter(
		(o) => o.key !== ownKey && o.key.endsWith(".json"),
	);
	for (const object of objects) {
		const name = object.key.slice(folder.length);
		options.onProgress?.(`Comparing with ${name}`);
		let remote: Manifest;
		try {
			remote = await parseManifest(
				await client.get(object.key),
				creds.passphrase,
			);
		} catch (error) {
			report.errors.push(`${name}: ${describe(error)}`);
			continue;
		}
		report.devices.push(
			compareManifests(local, remote, { now, graceMs: options.graceMs }),
		);
	}
	report.devices.sort((a, b) => a.manifestAgeMs - b.manifestAgeMs);
	return report;
}
