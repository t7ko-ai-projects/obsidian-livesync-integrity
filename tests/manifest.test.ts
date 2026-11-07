import assert from "node:assert/strict";
import { test } from "node:test";
import { utf8 } from "../src/bytes";
import {
	decryptBytes,
	deriveHashKey,
	encryptBytes,
	hashFile,
} from "../src/crypto/manifest-crypto";
import { credentialsFromSettings } from "../src/livesync-credentials";
import {
	compileExclusions,
	isExcluded,
	MANIFEST_FORMAT,
	manifestKey,
	parseManifest,
	serializeManifest,
	type Manifest,
} from "../src/manifest";

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
		deviceId: "dev1",
		deviceName: "PC",
		createdAt: 123,
		files: { "a.md": { h: "00", s: 1, m: 2 } },
	};
	const container = await serializeManifest(manifest, "pw");
	assert.equal(container[0], 1);
	assert.deepEqual(await parseManifest(container, "pw"), manifest);
	await assert.rejects(parseManifest(container, "nope"), /cannot decrypt/);
	// Two encryptions differ (random salt and IV) but both decrypt.
	const again = await serializeManifest(manifest, "pw");
	assert.notDeepEqual(
		Array.from(again.subarray(0, 29)),
		Array.from(container.subarray(0, 29)),
	);
	assert.deepEqual(await parseManifest(again, "pw"), manifest);
});

test("malformed manifests are rejected", async () => {
	await assert.rejects(decryptBytes("pw", new Uint8Array(5)), /too short/);
	const bad = await encryptBytes("pw", utf8(JSON.stringify({ format: "x" })));
	await assert.rejects(parseManifest(bad, "pw"), /unknown manifest format/);
	const badEntry = await encryptBytes(
		"pw",
		utf8(
			JSON.stringify({
				format: MANIFEST_FORMAT,
				deviceId: "d",
				deviceName: "",
				createdAt: 1,
				files: { "a.md": { h: 1 } },
			}),
		),
	);
	await assert.rejects(parseManifest(badEntry, "pw"), /malformed file entry/);
});

test("manifest keys live under _integrity below the bucket prefix", () => {
	assert.equal(manifestKey("vault/", "abc"), "vault/_integrity/abc.json");
	assert.equal(manifestKey("", "abc"), "_integrity/abc.json");
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
});
