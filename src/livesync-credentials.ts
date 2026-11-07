/**
 * Reads the S3 connection and the E2EE passphrase from the running LiveSync
 * plugin. These are undocumented internals of Self-hosted LiveSync, so every
 * field is checked and a missing one is reported, never guessed.
 */
import type { App } from "obsidian";
import { parseCustomHeaders, type S3Credentials } from "./s3/client";

export const LIVESYNC_PLUGIN_ID = "obsidian-livesync";
/** LiveSync's remoteType value for Object Storage (REMOTE_MINIO in commonlib). */
const REMOTE_MINIO = "MINIO";

export interface LiveSyncCredentials extends S3Credentials {
	bucketPrefix: string;
	passphrase: string;
}

export type CredentialsResult =
	{ ok: true; creds: LiveSyncCredentials } | { ok: false; reason: string };

interface PluginRegistry {
	plugins?: { plugins?: Record<string, { settings?: unknown } | undefined> };
}

export function readLiveSyncSettings(app: App): unknown {
	const registry = app as unknown as PluginRegistry;
	return registry.plugins?.plugins?.[LIVESYNC_PLUGIN_ID]?.settings;
}

/** Validate a LiveSync settings object; exported for tests. */
export function credentialsFromSettings(settings: unknown): CredentialsResult {
	if (typeof settings !== "object" || settings === null) {
		return {
			ok: false,
			reason: "Self-hosted LiveSync is not loaded or has no settings",
		};
	}
	const s = settings as Record<string, unknown>;
	if (s.remoteType !== REMOTE_MINIO) {
		return {
			ok: false,
			reason: `LiveSync is not in Object Storage (S3) mode (remoteType is "${String(s.remoteType)}")`,
		};
	}
	if (s.encrypt !== true) {
		return {
			ok: false,
			reason: "LiveSync end-to-end encryption is off; the integrity check needs its passphrase",
		};
	}
	const required = [
		"endpoint",
		"region",
		"bucket",
		"accessKey",
		"secretKey",
		"passphrase",
	] as const;
	for (const name of required) {
		if (typeof s[name] !== "string" || s[name].trim() === "") {
			return {
				ok: false,
				reason: `LiveSync setting "${name}" is missing or empty`,
			};
		}
	}
	for (const name of ["bucketPrefix", "bucketCustomHeaders"] as const) {
		if (s[name] !== undefined && typeof s[name] !== "string") {
			return {
				ok: false,
				reason: `LiveSync setting "${name}" has an unexpected type`,
			};
		}
	}
	if (typeof s.forcePathStyle !== "boolean") {
		return {
			ok: false,
			reason: 'LiveSync setting "forcePathStyle" is missing',
		};
	}
	const endpoint = (s.endpoint as string).trim();
	let protocol: string;
	try {
		protocol = new URL(endpoint).protocol;
	} catch {
		return {
			ok: false,
			reason: `LiveSync endpoint is not a URL: ${endpoint}`,
		};
	}
	if (protocol !== "https:" && protocol !== "http:") {
		return {
			ok: false,
			reason: `LiveSync endpoint must be http(s), not ${protocol}`,
		};
	}
	return {
		ok: true,
		creds: {
			endpoint,
			region: (s.region as string).trim(),
			bucket: (s.bucket as string).trim(),
			bucketPrefix: (s.bucketPrefix as string | undefined) ?? "",
			accessKey: s.accessKey as string,
			secretKey: s.secretKey as string,
			forcePathStyle: s.forcePathStyle,
			customHeaders: parseCustomHeaders(
				(s.bucketCustomHeaders as string | undefined) ?? "",
			),
			passphrase: s.passphrase as string,
		},
	};
}

export function readLiveSyncCredentials(app: App): CredentialsResult {
	return credentialsFromSettings(readLiveSyncSettings(app));
}
