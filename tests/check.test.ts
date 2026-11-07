import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "obsidian";
import { utf8 } from "../src/bytes";
import { MAX_MANIFESTS, runIntegrityCheck } from "../src/check";
import type { LiveSyncCredentials } from "../src/livesync-credentials";
import {
	MANIFEST_FORMAT,
	parseManifest,
	serializeManifest,
	type Manifest,
} from "../src/manifest";
import type { RequestFn } from "../src/s3/client";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const PC = "0000000000000001";
const PHONE = "0000000000000002";

const creds: LiveSyncCredentials = {
	endpoint: "https://s3.example.com",
	region: "auto",
	bucket: "bucket",
	bucketPrefix: "vault/",
	accessKey: "ak",
	secretKey: "sk",
	forcePathStyle: true,
	customHeaders: {},
	passphrase: "pw",
};

/** A synthetic vault: path -> [content, mtime]. */
function fakeApp(files: Record<string, [string, number]>): App {
	const list = Object.entries(files).map(([path, [content, mtime]]) => ({
		path,
		stat: { size: content.length, mtime, ctime: mtime },
		content,
	}));
	return {
		vault: {
			getFiles: () => list,
			readBinary: (file: { content: string }) =>
				Promise.resolve(utf8(file.content).buffer as ArrayBuffer),
		},
	} as unknown as App;
}

/** An in-memory bucket that answers PUT, GET and LIST like S3. */
function fakeBucket(
	objects: Map<string, Uint8Array>,
	sizes: Map<string, number> = new Map(),
): RequestFn {
	return async (params) => {
		const url = new URL(params.url);
		const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ""));
		if (params.method === "PUT") {
			objects.set(key, new Uint8Array(params.body as ArrayBuffer));
			return { status: 200, text: "", arrayBuffer: new ArrayBuffer(0) };
		}
		if (url.searchParams.get("list-type") === "2") {
			const prefix = url.searchParams.get("prefix") ?? "";
			const contents = [...objects.keys()]
				.filter((k) => k.startsWith(prefix))
				.map(
					(k) =>
						`<Contents><Key>${k}</Key><Size>${sizes.get(k) ?? objects.get(k)?.length ?? 0}</Size></Contents>`,
				)
				.join("");
			return {
				status: 200,
				text: `<R>${contents}</R>`,
				arrayBuffer: new ArrayBuffer(0),
			};
		}
		const body = objects.get(key);
		if (!body) {
			return {
				status: 404,
				text: "<Error><Code>NoSuchKey</Code></Error>",
				arrayBuffer: new ArrayBuffer(0),
			};
		}
		return {
			status: 200,
			text: "",
			arrayBuffer: body.slice().buffer,
		};
	};
}

function manifest(deviceId: string, createdAt: number): Manifest {
	return {
		format: MANIFEST_FORMAT,
		deviceId,
		deviceName: deviceId,
		createdAt,
		files: {},
	};
}

test("a full check publishes the manifest and compares with the other devices", async () => {
	const objects = new Map<string, Uint8Array>();
	// Journal packs and foreign objects must not disturb the check.
	objects.set("vault/1700000000000-docs.jsonl.gz", new Uint8Array([1]));
	objects.set("vault/_integrity/garbage.json", utf8("not a manifest"));
	const phoneRun = await runIntegrityCheck(
		fakeApp({
			"a.md": ["same", NOW - 48 * HOUR],
			"b.md": ["phone version", NOW - 48 * HOUR],
			"phone-only.md": ["p", NOW - 48 * HOUR],
		}),
		creds,
		{
			deviceId: PHONE,
			deviceName: "Phone",
			exclusions: [],
			graceMs: HOUR / 2,
			now: NOW - HOUR,
			request: fakeBucket(objects),
		},
	);
	assert.equal(phoneRun.devices.length, 0);
	assert.deepEqual(phoneRun.errors, [
		"1 object(s) under _integrity/ are not manifests and were ignored",
	]);

	const pcRun = await runIntegrityCheck(
		fakeApp({
			"a.md": ["same", NOW - 48 * HOUR],
			"b.md": ["pc version", NOW - 48 * HOUR],
			"pc-only.md": ["c", NOW - 48 * HOUR],
			"fresh.md": ["just written", NOW - 1000],
			".obsidian/app.json": ["{}", NOW - 48 * HOUR],
		}),
		creds,
		{
			deviceId: PC,
			deviceName: "PC",
			exclusions: [/^\.obsidian\//],
			graceMs: HOUR / 2,
			staleMs: 18 * HOUR,
			now: NOW,
			request: fakeBucket(objects),
		},
	);
	assert.equal(pcRun.localFileCount, 4);
	assert.equal(pcRun.devices.length, 1);
	const phone = pcRun.devices[0]!;
	assert.equal(phone.deviceName, "Phone");
	assert.equal(phone.manifestAgeMs, HOUR);
	assert.equal(phone.manifestCreatedAt, NOW - HOUR);
	assert.equal(phone.stale, false);
	assert.deepEqual(phone.differing, ["b.md"]);
	assert.deepEqual(phone.onlyHere, ["pc-only.md"]);
	assert.deepEqual(phone.onlyThere, ["phone-only.md"]);
	assert.equal(phone.pending, 1);

	// Only the two manifests were written; LiveSync's journal is untouched.
	assert.deepEqual([...objects.keys()].sort(), [
		"vault/1700000000000-docs.jsonl.gz",
		`vault/_integrity/${PC}.json`,
		`vault/_integrity/${PHONE}.json`,
		"vault/_integrity/garbage.json",
	]);
	const stored = await parseManifest(
		objects.get(`vault/_integrity/${PC}.json`)!,
		"pw",
		PC,
	);
	assert.equal(stored.deviceId, PC);
	assert.equal(Object.keys(stored.files).length, 4);
	assert.equal(stored.files[".obsidian/app.json"], undefined);
});

test("an upload failure aborts the check with the S3 error code only", async () => {
	await assert.rejects(
		runIntegrityCheck(fakeApp({}), creds, {
			deviceId: PC,
			deviceName: "",
			exclusions: [],
			graceMs: 0,
			request: async () => ({
				status: 403,
				text: "<Error><Code>SignatureDoesNotMatch</Code><Message>secret stuff</Message><CanonicalRequest>x-token:abc</CanonicalRequest></Error>",
				arrayBuffer: new ArrayBuffer(0),
			}),
		}),
		(error: Error) => {
			assert.match(
				error.message,
				/^S3 PUT answered 403 \(SignatureDoesNotMatch: secret stuff\)$/,
			);
			return true;
		},
	);
});

test("oversized manifests are skipped and the manifest count is capped", async () => {
	const objects = new Map<string, Uint8Array>();
	const sizes = new Map<string, number>();
	const ids: string[] = [];
	for (let i = 0; i < MAX_MANIFESTS + 2; i += 1) {
		const id = (0x100 + i).toString(16).padStart(16, "0");
		ids.push(id);
		objects.set(
			`vault/_integrity/${id}.json`,
			await serializeManifest(manifest(id, NOW - HOUR), "pw"),
		);
	}
	// Report a huge size for the first one; a GET of it must not happen.
	sizes.set(`vault/_integrity/${ids[0]}.json`, 17 * 1024 * 1024);
	let gets = 0;
	const bucket = fakeBucket(objects, sizes);
	const report = await runIntegrityCheck(fakeApp({}), creds, {
		deviceId: PC,
		deviceName: "",
		exclusions: [],
		graceMs: 0,
		now: NOW,
		request: async (params) => {
			if (
				params.method !== "PUT" &&
				!params.url.includes("list-type=2")
			) {
				gets += 1;
				assert.ok(!params.url.includes(ids[0]!));
			}
			return bucket(params);
		},
	});
	assert.equal(gets, MAX_MANIFESTS - 1);
	assert.equal(report.devices.length, MAX_MANIFESTS - 1);
	assert.ok(
		report.errors.some((e) =>
			e.includes(`${MAX_MANIFESTS + 2} other manifests found`),
		),
	);
	assert.ok(
		report.errors.some(
			(e) => e.startsWith(ids[0]!) && e.includes("above the"),
		),
	);
});

test("a manifest copied under another device's key is rejected", async () => {
	const objects = new Map<string, Uint8Array>();
	const phoneManifest = await serializeManifest(
		manifest(PHONE, NOW - HOUR),
		"pw",
	);
	const third = "0000000000000003";
	objects.set(`vault/_integrity/${third}.json`, phoneManifest);
	const report = await runIntegrityCheck(fakeApp({}), creds, {
		deviceId: PC,
		deviceName: "",
		exclusions: [],
		graceMs: 0,
		now: NOW,
		request: fakeBucket(objects),
	});
	assert.equal(report.devices.length, 0);
	assert.deepEqual(report.errors, [
		`${third}: cannot decrypt the manifest (different passphrase, wrong device key, or damaged file)`,
	]);
});

test("rolled back, stale and vanished manifests are reported", async () => {
	const objects = new Map<string, Uint8Array>();
	objects.set(
		`vault/_integrity/${PHONE}.json`,
		await serializeManifest(manifest(PHONE, NOW - 30 * HOUR), "pw"),
	);
	const report = await runIntegrityCheck(fakeApp({}), creds, {
		deviceId: PC,
		deviceName: "",
		exclusions: [],
		graceMs: 0,
		staleMs: 18 * HOUR,
		now: NOW,
		previouslySeen: { [PHONE]: NOW - 2 * HOUR, "00000000000000ff": NOW },
		request: fakeBucket(objects),
	});
	assert.equal(report.devices.length, 1);
	assert.equal(report.devices[0]!.stale, true);
	assert.equal(report.errors.length, 3);
	assert.match(report.errors[0]!, /went backwards in time/);
	assert.match(report.errors[1]!, /manifest is 30 h old/);
	assert.match(
		report.errors[2]!,
		/00000000000000ff: manifest seen before has disappeared/,
	);
});

test("keys outside the manifest folder are never fetched", async () => {
	const fetched: string[] = [];
	const report = await runIntegrityCheck(fakeApp({}), creds, {
		deviceId: PC,
		deviceName: "",
		exclusions: [],
		graceMs: 0,
		now: NOW,
		request: async (params) => {
			if (params.url.includes("list-type=2")) {
				return {
					status: 200,
					text: `<R><Contents><Key>elsewhere/${PHONE}.json</Key><Size>1</Size></Contents><Contents><Key>vault/_integrity/../x.json</Key><Size>1</Size></Contents></R>`,
					arrayBuffer: new ArrayBuffer(0),
				};
			}
			if (params.method !== "PUT") {
				fetched.push(params.url);
			}
			return { status: 200, text: "", arrayBuffer: new ArrayBuffer(0) };
		},
	});
	assert.deepEqual(fetched, []);
	assert.equal(report.devices.length, 0);
});
