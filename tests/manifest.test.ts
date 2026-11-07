import assert from "node:assert/strict";
import { test } from "node:test";
import { utf8 } from "../src/bytes";
import { compareManifests } from "../src/compare";
import {
	decryptBytes,
	deriveHashKey,
	encryptBytes,
	hashFile,
} from "../src/crypto/manifest-crypto";
import { credentialsFromSettings } from "../src/livesync-credentials";
import {
	compileExclusions,
	deviceIdFromKey,
	isExcluded,
	isValidDeviceId,
	MANIFEST_FORMAT,
	MANIFEST_PAD_BYTES,
	manifestKey,
	padManifestJson,
	parseManifest,
	serializeManifest,
	type Manifest,
} from "../src/manifest";

const DEV = "0123456789abcdef";

test("file hashes are keyed by the passphrase and stable across calls", async () => {
	const content = utf8("hello").buffer as ArrayBuffer;
	const k1 = await deriveHashKey("pass");
	const k2 = await deriveHashKey("pass");
	const other = await deriveHashKey("other");
	const h1 = await hashFile(k1, content);
	assert.match(h1, /^[0-9a-f]{64}$/);
	assert.equal(h1, await hashFile(k2, content));
	assert.notEqual(h1, await hashFile(other, content));
});

test("manifest round-trips through encryption and rejects a wrong passphrase", async () => {
	const manifest: Manifest = {
		format: MANIFEST_FORMAT,
		deviceId: DEV,
		deviceName: "PC",
		createdAt: 123,
		files: { "a.md": { h: "00", s: 1, m: 2 } },
	};
	const container = await serializeManifest(manifest, "pw");
	assert.equal(container[0], 1);
	assert.deepEqual(await parseManifest(container, "pw", DEV), manifest);
	await assert.rejects(
		parseManifest(container, "nope", DEV),
		/cannot decrypt/,
	);
	// Two encryptions differ (random salt and IV) but both decrypt.
	const again = await serializeManifest(manifest, "pw");
	assert.notDeepEqual(
		Array.from(again.subarray(0, 29)),
		Array.from(container.subarray(0, 29)),
	);
	assert.deepEqual(await parseManifest(again, "pw", DEV), manifest);
});

test("the device id is authenticated data: a copied manifest does not open", async () => {
	const manifest: Manifest = {
		format: MANIFEST_FORMAT,
		deviceId: DEV,
		deviceName: "",
		createdAt: 1,
		files: {},
	};
	const container = await serializeManifest(manifest, "pw");
	await assert.rejects(
		parseManifest(container, "pw", "fedcba9876543210"),
		/cannot decrypt/,
	);
	// Same context but a lying inner id is also rejected.
	const lying = await encryptBytes(
		"pw",
		utf8(JSON.stringify({ ...manifest, deviceId: "fedcba9876543210" })),
		DEV,
	);
	await assert.rejects(
		parseManifest(lying, "pw", DEV),
		/names a different device/,
	);
});

test("manifest plaintext is padded to whole blocks", async () => {
	const small = padManifestJson("{}");
	assert.equal(small.length, MANIFEST_PAD_BYTES);
	assert.equal(new TextDecoder().decode(small).trimEnd(), "{}");
	const big = padManifestJson("x".repeat(MANIFEST_PAD_BYTES + 1));
	assert.equal(big.length, 2 * MANIFEST_PAD_BYTES);
	// Two manifests of different small sizes encrypt to the same length.
	const a = await serializeManifest(
		{
			format: MANIFEST_FORMAT,
			deviceId: DEV,
			deviceName: "",
			createdAt: 1,
			files: {},
		},
		"pw",
	);
	const b = await serializeManifest(
		{
			format: MANIFEST_FORMAT,
			deviceId: DEV,
			deviceName: "a long device name",
			createdAt: 1,
			files: {
				"some/long/path/to/a/note.md": {
					h: "0".repeat(64),
					s: 5,
					m: 6,
				},
			},
		},
		"pw",
	);
	assert.equal(a.length, b.length);
});

test("malformed manifests are rejected", async () => {
	await assert.rejects(
		decryptBytes("pw", new Uint8Array(5), DEV),
		/too short/,
	);
	const bad = await encryptBytes(
		"pw",
		utf8(JSON.stringify({ format: "x" })),
		DEV,
	);
	await assert.rejects(
		parseManifest(bad, "pw", DEV),
		/unknown manifest format/,
	);
	const badEntry = await encryptBytes(
		"pw",
		utf8(
			JSON.stringify({
				format: MANIFEST_FORMAT,
				deviceId: DEV,
				deviceName: "",
				createdAt: 1,
				files: { "a.md": { h: 1 } },
			}),
		),
		DEV,
	);
	await assert.rejects(
		parseManifest(badEntry, "pw", DEV),
		/malformed file entry/,
	);
});

test("manifest keys live under _integrity and only valid ids name them", () => {
	assert.equal(manifestKey("vault/", DEV), `vault/_integrity/${DEV}.json`);
	assert.equal(manifestKey("", DEV), `_integrity/${DEV}.json`);
	assert.throws(() => manifestKey("vault/", "../x"), /invalid device id/);
	assert.equal(isValidDeviceId(DEV), true);
	assert.equal(isValidDeviceId("0123456789ABCDEF"), false);
	assert.equal(isValidDeviceId("0123456789abcde"), false);
	assert.equal(isValidDeviceId(42), false);
	assert.equal(
		deviceIdFromKey("vault/", `vault/_integrity/${DEV}.json`),
		DEV,
	);
	assert.equal(
		deviceIdFromKey("vault/", `other/_integrity/${DEV}.json`),
		undefined,
	);
	assert.equal(
		deviceIdFromKey("vault/", "vault/_integrity/garbage.json"),
		undefined,
	);
	assert.equal(
		deviceIdFromKey("vault/", `vault/_integrity/${DEV}.txt`),
		undefined,
	);
	assert.equal(
		deviceIdFromKey("vault/", `vault/_integrity/sub/${DEV}.json`),
		undefined,
	);
});

test("a file named like an Object.prototype member compares correctly", () => {
	const entry = { h: "1", s: 1, m: 0 };
	const local: Manifest = {
		format: MANIFEST_FORMAT,
		deviceId: DEV,
		deviceName: "",
		createdAt: 1000,
		files: { constructor: entry, __proto__: entry, "toString.md": entry },
	};
	const remote: Manifest = {
		...local,
		deviceId: "fedcba9876543210",
		files: {},
	};
	const report = compareManifests(local, remote, { now: 1000, graceMs: 10 });
	assert.deepEqual(report.onlyHere, ["constructor", "toString.md"]);
	assert.equal(report.pending, 0);
});

test("exclusion patterns compile and invalid ones are reported", () => {
	const { regexes, invalid } = compileExclusions([
		"^\\.obsidian/",
		"(",
		"",
		"\\.tmp$",
	]);
	assert.deepEqual(invalid, ["("]);
	assert.equal(regexes.length, 2);
	assert.equal(isExcluded(".obsidian/app.json", regexes), true);
	assert.equal(isExcluded("notes/a.tmp", regexes), true);
	assert.equal(isExcluded("notes/a.md", regexes), false);
});

test("LiveSync settings are validated field by field", () => {
	const good = {
		remoteType: "MINIO",
		encrypt: true,
		endpoint: "https://s3.example.com",
		region: "auto",
		bucket: "b",
		bucketPrefix: "v/",
		accessKey: "ak",
		secretKey: "sk",
		forcePathStyle: true,
		bucketCustomHeaders: "X-A: 1",
		passphrase: "pw",
	};
	const ok = credentialsFromSettings(good);
	assert.ok(ok.ok);
	assert.deepEqual(ok.creds.customHeaders, { "X-A": "1" });
	assert.equal(ok.creds.bucketPrefix, "v/");

	const fails: [Record<string, unknown>, RegExp][] = [
		[{}, /not in Object Storage/],
		[undefined as unknown as Record<string, unknown>, /not loaded/],
		[{ ...good, remoteType: "" }, /not in Object Storage/],
		[{ ...good, encrypt: false }, /encryption is off/],
		[{ ...good, secretKey: " " }, /"secretKey" is missing/],
		[{ ...good, forcePathStyle: undefined }, /"forcePathStyle" is missing/],
		[{ ...good, endpoint: "not a url" }, /not a URL/],
		[
			{ ...good, endpoint: "ftp://s3.example.com" },
			/must be http\(s\), not ftp:/,
		],
		[{ ...good, endpoint: "file:///tmp" }, /must be http\(s\)/],
	];
	for (const [settings, pattern] of fails) {
		const result = credentialsFromSettings(settings);
		assert.ok(!result.ok);
		assert.match(result.reason, pattern);
	}
	const noPrefix = credentialsFromSettings({
		...good,
		bucketPrefix: undefined,
		bucketCustomHeaders: undefined,
	});
	assert.ok(noPrefix.ok);
	assert.equal(noPrefix.creds.bucketPrefix, "");
	assert.ok(
		credentialsFromSettings({ ...good, endpoint: "http://127.0.0.1:9000" })
			.ok,
	);
});
