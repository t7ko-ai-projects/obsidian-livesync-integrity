/** List and download the other devices' manifests, under the hostile-bucket caps. */
import type { LiveSyncCredentials } from "./livesync-credentials";
import {
	deviceIdFromKey,
	MANIFEST_FOLDER,
	parseManifest,
	type Manifest,
} from "./manifest";
import type { S3Client } from "./s3/client";

/** A manifest object larger than this is not downloaded. */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** More manifests than this are not compared; the rest is reported. */
export const MAX_MANIFESTS = 64;

export interface RemoteManifests {
	/** Decrypted manifests, sorted by device id. */
	manifests: Manifest[];
	/** Devices whose manifest was listed, readable or not. */
	listed: Set<string>;
	errors: string[];
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function fetchRemoteManifests(
	client: S3Client,
	creds: LiveSyncCredentials,
	ownDeviceId: string,
	onProgress?: (message: string) => void,
): Promise<RemoteManifests> {
	const result: RemoteManifests = {
		manifests: [],
		listed: new Set(),
		errors: [],
	};
	onProgress?.("Listing manifests");
	const folder = `${creds.bucketPrefix}${MANIFEST_FOLDER}`;
	const listing = await client.list(folder);
	if (listing.malformed > 0) {
		result.errors.push(
			`${listing.malformed} listing entr${listing.malformed === 1 ? "y" : "ies"} could not be read`,
		);
	}
	let own = 0;
	const candidates = listing.objects
		.map((object) => ({
			object,
			deviceId: deviceIdFromKey(creds.bucketPrefix, object.key),
		}))
		.filter((c): c is { object: typeof c.object; deviceId: string } => {
			if (c.deviceId === ownDeviceId) {
				own += 1;
				return false;
			}
			return c.deviceId !== undefined;
		})
		.sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
	const ignored = listing.objects.length - candidates.length - own;
	if (ignored > 0) {
		result.errors.push(
			`${ignored} object(s) under ${MANIFEST_FOLDER} are not manifests and were ignored`,
		);
	}
	if (candidates.length > MAX_MANIFESTS) {
		result.errors.push(
			`${candidates.length} other manifests found; only the first ${MAX_MANIFESTS} were compared`,
		);
		candidates.length = MAX_MANIFESTS;
	}
	for (const { object, deviceId } of candidates) {
		result.listed.add(deviceId);
		onProgress?.(`Reading manifest of ${deviceId}`);
		if (object.size > MAX_MANIFEST_BYTES) {
			result.errors.push(
				`${deviceId}: manifest is ${object.size} bytes, above the ${MAX_MANIFEST_BYTES} byte limit`,
			);
			continue;
		}
		try {
			result.manifests.push(
				await parseManifest(
					await client.get(object.key, MAX_MANIFEST_BYTES),
					creds.passphrase,
					deviceId,
				),
			);
		} catch (error) {
			result.errors.push(`${deviceId}: ${describe(error)}`);
		}
	}
	return result;
}
