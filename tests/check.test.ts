import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "obsidian";
import { utf8 } from "../src/bytes";
import { runIntegrityCheck } from "../src/check";
import type { LiveSyncCredentials } from "../src/livesync-credentials";
import {
	parseManifest,
	serializeManifest,
	type Manifest,
} from "../src/manifest";
import type { RequestFn } from "../src/s3/client";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

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
function fakeBucket(objects: Map<string, Uint8Array>): RequestFn {
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
						`<Contents><Key>${k}</Key><Size>${objects.get(k)?.length ?? 0}</Size></Contents>`,
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
				text: "<Error>NoSuchKey</Error>",
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

test("a full check publishes the manifest and compares with the other devices", async () => {
	const objects = new Map<string, Uint8Array>();
	// Journal packs and a foreign manifest must not disturb the check.
	objects.set("vault/1700000000000-docs.jsonl.gz", new Uint8Array([1]));
	objects.set("vault/_integrity/garbage.json", utf8("not encrypted"));
	const phoneRun = await runIntegrityCheck(
		fakeApp({
			"a.md": ["same", NOW - 48 * HOUR],
			"b.md": ["phone version", NOW - 48 * HOUR],
			"phone-only.md": ["p", NOW - 48 * HOUR],
		}),
		creds,
		{
			deviceId: "phone",
			deviceName: "Phone",
			exclusions: [],
			graceMs: HOUR / 2,
			now: NOW - HOUR,
			request: fakeBucket(objects),
		},
	);
	assert.equal(phoneRun.devices.length, 0);
	assert.deepEqual(phoneRun.errors, ["garbage.json: manifest is too short"]);

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
			deviceId: "pc",
			deviceName: "PC",
			exclusions: [/^\.obsidian\//],
			graceMs: HOUR / 2,
			now: NOW,
			request: fakeBucket(objects),
		},
	);
	assert.equal(pcRun.localFileCount, 4);
	assert.equal(pcRun.devices.length, 1);
	const phone = pcRun.devices[0]!;
	assert.equal(phone.deviceName, "Phone");
	assert.equal(phone.manifestAgeMs, HOUR);
	assert.deepEqual(phone.differing, ["b.md"]);
	assert.deepEqual(phone.onlyHere, ["pc-only.md"]);
	assert.deepEqual(phone.onlyThere, ["phone-only.md"]);
	assert.equal(phone.pending, 1);

	// Only the two manifests were written; LiveSync's journal is untouched.
	assert.deepEqual([...objects.keys()].sort(), [
		"vault/1700000000000-docs.jsonl.gz",
		"vault/_integrity/garbage.json",
		"vault/_integrity/pc.json",
		"vault/_integrity/phone.json",
	]);
	const stored: Manifest = await parseManifest(
		objects.get("vault/_integrity/pc.json")!,
		"pw",
	);
	assert.equal(stored.deviceId, "pc");
	assert.equal(Object.keys(stored.files).length, 4);
	assert.equal(stored.files[".obsidian/app.json"], undefined);
});

test("an upload failure aborts the check with the S3 error", async () => {
	await assert.rejects(
		runIntegrityCheck(fakeApp({}), creds, {
			deviceId: "d",
			deviceName: "",
			exclusions: [],
			graceMs: 0,
			request: async () => ({
				status: 403,
				text: "AccessDenied",
				arrayBuffer: new ArrayBuffer(0),
			}),
		}),
		/S3 PUT answered 403: AccessDenied/,
	);
	// serializeManifest is covered here only to keep the import used.
	assert.ok(typeof serializeManifest === "function");
});
