import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "obsidian";
import { utf8 } from "../src/bytes";
import {
	computeDigest,
	digestGroup,
	isAutoDigestDue,
	isEarlierLocalDay,
	isSameLocalDay,
	markDigestSeen,
	noteDigestShown,
	type DigestState,
	type DigestBaseline,
} from "../src/digest";
import { runDigest } from "../src/digest-run";
import type { LiveSyncCredentials } from "../src/livesync-credentials";
import {
	MANIFEST_FORMAT,
	serializeManifest,
	type Manifest,
	type ManifestEntry,
} from "../src/manifest";
import type { RequestFn } from "../src/s3/client";
import { describeEntry, formatDelta, formatSize } from "../src/ui/digest-modal";

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

function e(h: string, s: number, m: number): ManifestEntry {
	return { h, s, m };
}

function remote(
	deviceId: string,
	deviceName: string,
	createdAt: number,
	files: Record<string, ManifestEntry>,
): Manifest {
	return { format: MANIFEST_FORMAT, deviceId, deviceName, createdAt, files };
}

const baseline: DigestBaseline = {
	savedAt: T0,
	files: {
		"keep.md": e("k", 10, T0 - HOUR),
		"edit.md": e("e1", 100, T0 - HOUR),
		"gone.md": e("g", 5, T0 - 2 * HOUR),
		"old-name.md": e("same", 50, T0 - 3 * HOUR),
	},
};

test("digest lists added, modified and deleted files, newest first", () => {
	const entries = computeDigest(baseline, {
		"keep.md": e("k", 10, T0 - HOUR),
		"edit.md": e("e2", 130, T0 + 2 * HOUR),
		"new.md": e("n", 7, T0 + 3 * HOUR),
		"old-name.md": e("same", 50, T0 - 3 * HOUR),
	});
	assert.deepEqual(
		entries.map((x) => [x.kind, x.path]),
		[
			["added", "new.md"],
			["modified", "edit.md"],
			["deleted", "gone.md"],
		],
	);
	assert.equal(entries[1]?.sizeDelta, 30);
	assert.equal(entries[2]?.size, 5);
	assert.equal(entries[2]?.mtime, T0 - 2 * HOUR);
	assert.equal(digestGroup(entries, "renamed").length, 0);
});

test("a deleted path whose hash reappears elsewhere is one rename", () => {
	const entries = computeDigest(baseline, {
		"keep.md": e("k", 10, T0 - HOUR),
		"edit.md": e("e1", 100, T0 - HOUR),
		"gone.md": e("g", 5, T0 - 2 * HOUR),
		"folder/new-name.md": e("same", 50, T0 + HOUR),
	});
	assert.deepEqual(entries, [
		{
			kind: "renamed",
			path: "folder/new-name.md",
			oldPath: "old-name.md",
			size: 50,
			mtime: T0 + HOUR,
			device: undefined,
		},
	]);
});

test("two identical files renamed pair up one to one", () => {
	const entries = computeDigest(
		{
			savedAt: T0,
			files: { "a.md": e("x", 1, T0), "b.md": e("x", 1, T0) },
		},
		{ "c.md": e("x", 1, T0 + 1), "d.md": e("x", 1, T0 + 2) },
	);
	assert.deepEqual(entries.map((x) => [x.kind, x.oldPath, x.path]).sort(), [
		["renamed", "a.md", "c.md"],
		["renamed", "b.md", "d.md"],
	]);
});

test("changes are attributed to a device whose newer manifest carries them", () => {
	const phone = remote("0000000000000002", "Phone", T0 + 4 * HOUR, {
		"keep.md": e("k", 10, T0 - HOUR),
		"edit.md": e("e2", 130, T0 + 2 * HOUR),
		"new.md": e("n", 7, T0 + 3 * HOUR),
	});
	const entries = computeDigest(
		baseline,
		{
			"keep.md": e("k", 10, T0 - HOUR),
			"edit.md": e("e2", 130, T0 + 2 * HOUR),
			"new.md": e("n", 7, T0 + 3 * HOUR),
			"local-only.md": e("l", 1, T0 + 5 * HOUR),
			"old-name.md": e("same", 50, T0 - 3 * HOUR),
		},
		[phone],
	);
	const byPath = Object.fromEntries(entries.map((x) => [x.path, x.device]));
	assert.equal(byPath["edit.md"], "Phone");
	assert.equal(byPath["new.md"], "Phone");
	assert.equal(byPath["gone.md"], "Phone");
	assert.equal(byPath["local-only.md"], undefined);
});

test("an old remote manifest attributes nothing", () => {
	const stale = remote("0000000000000002", "", T0 - HOUR, {
		"edit.md": e("e2", 130, T0 - 2 * HOUR),
	});
	const entries = computeDigest(
		baseline,
		{ "edit.md": e("e2", 130, T0 + HOUR) },
		[stale],
	);
	for (const entry of entries) {
		assert.equal(entry.device, undefined);
	}
});

test("a file named like an Object.prototype member is diffed by own property", () => {
	const entries = computeDigest(
		{ savedAt: T0, files: {} },
		{ constructor: e("c", 1, T0 + 1) },
	);
	assert.deepEqual(
		entries.map((x) => [x.kind, x.path]),
		[["added", "constructor"]],
	);
});

test("isEarlierLocalDay compares local calendar days", () => {
	const noon = new Date(2026, 10, 7, 12, 0, 0).getTime();
	assert.equal(isEarlierLocalDay(noon, noon + 11 * HOUR), false);
	assert.equal(isEarlierLocalDay(noon, noon + 12 * HOUR), true);
	assert.equal(isEarlierLocalDay(noon, noon + 40 * 24 * HOUR), true);
	assert.equal(isEarlierLocalDay(noon + 24 * HOUR, noon), false);
});

test("showing the digest keeps the baseline; marking as seen replaces it", () => {
	const old: DigestBaseline = {
		savedAt: T0,
		files: { "a.md": e("a", 1, T0) },
	};
	const scan: DigestBaseline = {
		savedAt: T0 + 30 * HOUR,
		files: { "b.md": e("b", 2, T0 + HOUR) },
	};
	const state: DigestState = {
		digestEnabled: true,
		digestBaseline: old,
		digestLastShownAt: 0,
	};
	noteDigestShown(state, T0 + 30 * HOUR, true);
	assert.equal(state.digestBaseline, old, "manual show keeps the baseline");
	assert.equal(state.digestLastShownAt, 0, "manual show is not recorded");
	noteDigestShown(state, T0 + 30 * HOUR, false);
	assert.equal(state.digestBaseline, old, "automatic show keeps it too");
	assert.equal(state.digestLastShownAt, T0 + 30 * HOUR);
	markDigestSeen(state, scan);
	assert.equal(state.digestBaseline, scan);
});

test("the automatic digest is due once per day until marked as seen", () => {
	const day = (n: number, hour: number) =>
		new Date(2026, 10, 7 + n, hour, 0, 0).getTime();
	const state: DigestState = {
		digestEnabled: true,
		digestBaseline: { savedAt: day(0, 12), files: {} },
		digestLastShownAt: 0,
	};
	assert.equal(isAutoDigestDue(state, day(0, 20)), false, "same day");
	assert.equal(isAutoDigestDue(state, day(1, 9)), true, "next day");
	noteDigestShown(state, day(1, 9), false);
	assert.equal(isAutoDigestDue(state, day(1, 18)), false, "shown today");
	assert.equal(isAutoDigestDue(state, day(2, 9)), true, "back the day after");
	markDigestSeen(state, { savedAt: day(2, 9), files: {} });
	assert.equal(isAutoDigestDue(state, day(2, 10)), false, "fresh baseline");
	assert.equal(isAutoDigestDue(state, day(3, 10)), true);
	state.digestEnabled = false;
	assert.equal(isAutoDigestDue(state, day(3, 10)), false, "disabled");
	assert.equal(
		isAutoDigestDue(
			{ digestEnabled: true, digestBaseline: null, digestLastShownAt: 0 },
			day(0, 12),
		),
		true,
		"no baseline: the first run records one",
	);
	assert.equal(isSameLocalDay(day(0, 1), day(0, 23)), true);
	assert.equal(isSameLocalDay(day(0, 23), day(1, 1)), false);
});

test("sizes and deltas are formatted for people", () => {
	assert.equal(formatSize(512), "512 B");
	assert.equal(formatSize(2048), "2.0 KB");
	assert.equal(formatSize(3 * 1024 * 1024), "3.0 MB");
	assert.equal(formatDelta(-1536), "-1.5 KB");
	assert.equal(formatDelta(0), "+0 B");
	const text = describeEntry({
		kind: "modified",
		path: "a.md",
		size: 2048,
		sizeDelta: 1024,
		mtime: T0,
		device: "Phone",
	});
	assert.ok(text.startsWith("+1.0 KB, now 2.0 KB, "));
	assert.ok(text.endsWith(", from Phone"));
});

// A run against a synthetic vault and bucket.

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

function fakeBucket(
	objects: Map<string, Uint8Array>,
	methods: string[],
): RequestFn {
	return (params) => {
		methods.push(params.method ?? "GET");
		const url = new URL(params.url);
		const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ""));
		if (url.searchParams.get("list-type") === "2") {
			const prefix = url.searchParams.get("prefix") ?? "";
			const contents = [...objects.keys()]
				.filter((k) => k.startsWith(prefix))
				.map(
					(k) =>
						`<Contents><Key>${k}</Key><Size>${objects.get(k)?.length ?? 0}</Size></Contents>`,
				)
				.join("");
			return Promise.resolve({
				status: 200,
				text: `<R>${contents}</R>`,
				arrayBuffer: new ArrayBuffer(0),
			});
		}
		const body = objects.get(key);
		if (!body) {
			return Promise.resolve({
				status: 404,
				text: "<Error><Code>NoSuchKey</Code></Error>",
				arrayBuffer: new ArrayBuffer(0),
			});
		}
		return Promise.resolve({
			status: 200,
			text: "",
			arrayBuffer: body.buffer.slice(
				body.byteOffset,
				body.byteOffset + body.byteLength,
			),
		});
	};
}

test("a digest run records a baseline first, then diffs and attributes without uploading", async () => {
	const methods: string[] = [];
	const objects = new Map<string, Uint8Array>();
	const request = fakeBucket(objects, methods);
	const PC = "0000000000000001";
	const PHONE = "0000000000000002";

	const first = await runDigest(
		fakeApp({ "a.md": ["one", T0 - HOUR] }),
		creds,
		{
			deviceId: PC,
			exclusions: [],
			baseline: null,
			now: T0,
			request,
		},
	);
	assert.equal(first.entries, null);
	assert.deepEqual(Object.keys(first.baseline.files), ["a.md"]);
	assert.equal(methods.length, 0, "no bucket access on the first run");

	// The phone edited a.md and published a manifest after the baseline.
	const later = await runDigest(
		fakeApp({ "a.md": ["two", T0 + HOUR] }),
		creds,
		{ deviceId: PHONE, exclusions: [], baseline: null, now: T0 + 2 * HOUR },
	);
	const phoneManifest: Manifest = {
		format: MANIFEST_FORMAT,
		deviceId: PHONE,
		deviceName: "Phone",
		createdAt: T0 + 2 * HOUR,
		files: later.baseline.files,
	};
	objects.set(
		`vault/_integrity/${PHONE}.json`,
		await serializeManifest(phoneManifest, creds.passphrase),
	);

	const second = await runDigest(
		fakeApp({ "a.md": ["two", T0 + HOUR], "b.md": ["new", T0 + 3 * HOUR] }),
		creds,
		{
			deviceId: PC,
			exclusions: [],
			baseline: first.baseline,
			now: T0 + 4 * HOUR,
			request,
		},
	);
	assert.deepEqual(
		second.entries?.map((x) => [x.kind, x.path, x.device]),
		[
			["added", "b.md", undefined],
			["modified", "a.md", "Phone"],
		],
	);
	assert.deepEqual(second.notes, []);
	assert.ok(
		!methods.includes("PUT"),
		"the digest never writes to the bucket",
	);
	assert.equal(second.baseline.savedAt, T0 + 4 * HOUR);
});

test("a digest run with an unreachable bucket still lists changes, unattributed", async () => {
	const failing: RequestFn = () => Promise.reject(new Error("offline"));
	const result = await runDigest(
		fakeApp({ "a.md": ["two", T0 + HOUR] }),
		creds,
		{
			deviceId: "0000000000000001",
			exclusions: [],
			baseline: { savedAt: T0, files: {} },
			now: T0 + 2 * HOUR,
			request: failing,
		},
	);
	assert.deepEqual(
		result.entries?.map((x) => [x.kind, x.path, x.device]),
		[["added", "a.md", undefined]],
	);
	assert.equal(result.notes.length, 1);
	assert.match(result.notes[0] ?? "", /offline/);
});
