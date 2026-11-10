import assert from "node:assert/strict";
import { test } from "node:test";
import {
	compareManifests,
	confirmMismatches,
	mismatchCount,
	mismatchKeys,
	unconfirmedCount,
} from "../src/compare";
import {
	MANIFEST_FORMAT,
	type Manifest,
	type ManifestEntry,
} from "../src/manifest";

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;
const GRACE = 30 * MINUTE;

function manifest(
	deviceId: string,
	createdAt: number,
	files: Record<string, ManifestEntry>,
): Manifest {
	return {
		format: MANIFEST_FORMAT,
		deviceId,
		deviceName: deviceId,
		createdAt,
		files,
	};
}

const old = (h: string, m = NOW - 24 * 60 * MINUTE): ManifestEntry => ({
	h,
	s: 1,
	m,
});

test("equal manifests produce no mismatches", () => {
	const local = manifest("a", NOW, { "x.md": old("1"), "y.md": old("2") });
	const remote = manifest("b", NOW - 5 * MINUTE, {
		"x.md": old("1"),
		"y.md": old("2"),
	});
	const report = compareManifests(local, remote, {
		now: NOW,
		graceMs: GRACE,
	});
	assert.deepEqual(
		[report.differing, report.onlyHere, report.onlyThere],
		[[], [], []],
	);
	assert.equal(report.pending, 0);
	assert.equal(report.manifestAgeMs, 5 * MINUTE);
});

test("flags settled differences and one-sided files", () => {
	const local = manifest("a", NOW, { "x.md": old("1"), "here.md": old("h") });
	const remote = manifest("b", NOW - MINUTE, {
		"x.md": old("2"),
		"there.md": old("t"),
	});
	const report = compareManifests(local, remote, {
		now: NOW,
		graceMs: GRACE,
	});
	assert.deepEqual(report.differing, ["x.md"]);
	assert.deepEqual(report.onlyHere, ["here.md"]);
	assert.deepEqual(report.onlyThere, ["there.md"]);
	const full = {
		createdAt: NOW,
		localFileCount: 2,
		devices: [report],
		errors: [],
	};
	assert.equal(mismatchCount(full), 3);
	assert.deepEqual(mismatchKeys(full), [
		"b|differ|x.md",
		"b|here|here.md",
		"b|there|there.md",
	]);
});

test("a file changed inside the grace window is pending, not flagged", () => {
	const recent = NOW - 10 * MINUTE;
	const local = manifest("a", NOW, {
		"x.md": old("1", recent),
		"new.md": old("n", recent),
	});
	const remote = manifest("b", NOW, { "x.md": old("2") });
	const report = compareManifests(local, remote, {
		now: NOW,
		graceMs: GRACE,
	});
	assert.deepEqual(report.differing, []);
	assert.deepEqual(report.onlyHere, []);
	assert.equal(report.pending, 2);
});

test("the grace window counts back from the older manifest", () => {
	// The remote scanned 2 h ago; a file edited 1 h ago cannot be there yet.
	const remoteAt = NOW - 120 * MINUTE;
	const local = manifest("a", NOW, { "x.md": old("1", NOW - 60 * MINUTE) });
	const remote = manifest("b", remoteAt, {
		"x.md": old("2", NOW - 48 * 60 * MINUTE),
	});
	const report = compareManifests(local, remote, {
		now: NOW,
		graceMs: GRACE,
	});
	assert.deepEqual(report.differing, []);
	assert.equal(report.pending, 1);
	// Edited 3 h ago: both sides should have settled before the remote scan.
	local.files["x.md"] = old("1", NOW - 180 * MINUTE);
	assert.deepEqual(
		compareManifests(local, remote, { now: NOW, graceMs: GRACE }).differing,
		["x.md"],
	);
});

test("a remote file newer than the window stays pending on the remote side", () => {
	const local = manifest("a", NOW, {});
	const remote = manifest("b", NOW, { "t.md": old("t", NOW - 5 * MINUTE) });
	const report = compareManifests(local, remote, {
		now: NOW,
		graceMs: GRACE,
	});
	assert.deepEqual(report.onlyThere, []);
	assert.equal(report.pending, 1);
});

test("the same content under different paths is a move, not two mismatches", () => {
	const HOUR = 60 * MINUTE;
	const local = manifest("pc", NOW, {
		"Self-Help/Log.md": old("same"),
		"here-only.md": old("x"),
	});
	const remote = manifest("phone", NOW - 18 * HOUR, {
		"Untitled/Log.md": old("same"),
		"there-only.md": old("y"),
	});
	const report = compareManifests(local, remote, {
		now: NOW,
		graceMs: GRACE,
	});
	assert.deepEqual(report.moved, ["Untitled/Log.md -> Self-Help/Log.md"]);
	assert.deepEqual(report.onlyHere, ["here-only.md"]);
	assert.deepEqual(report.onlyThere, ["there-only.md"]);
	assert.equal(
		mismatchCount({
			createdAt: NOW,
			localFileCount: 2,
			devices: [report],
			errors: [],
		}),
		2,
	);
});

test("a mismatch counts only when the previous check saw it too", () => {
	const build = () => {
		const local = manifest("pc", NOW, {
			"stale-copy.md": old("v1"),
			"real-drift.md": old("a"),
			"mine.md": old("m"),
		});
		const remote = manifest("phone", NOW - 2 * 60 * MINUTE, {
			"stale-copy.md": old("v2"),
			"real-drift.md": old("b"),
			"theirs.md": old("t"),
		});
		const device = compareManifests(local, remote, {
			now: NOW,
			graceMs: GRACE,
		});
		return {
			createdAt: NOW,
			localFileCount: 3,
			devices: [device],
			errors: [],
		};
	};

	// First check: the previous check had seen only real-drift.md.
	const first = build();
	const seenBefore = new Set(["phone|differ|real-drift.md"]);
	confirmMismatches(first, seenBefore);
	assert.deepEqual(first.devices[0]?.differing, ["real-drift.md"]);
	assert.deepEqual(first.devices[0]?.onlyHere, []);
	assert.deepEqual(first.devices[0]?.onlyThere, []);
	assert.deepEqual(first.devices[0]?.unconfirmed, [
		"different content: stale-copy.md",
		"only on this device: mine.md",
		"only on that device: theirs.md",
	]);
	assert.equal(mismatchCount(first), 1);
	assert.equal(unconfirmedCount(first), 3);
	assert.deepEqual(mismatchKeys(first), ["phone|differ|real-drift.md"]);

	// Next check: everything the first one saw is now confirmed.
	const second = build();
	confirmMismatches(second, new Set(mismatchKeys(build())));
	assert.equal(mismatchCount(second), 4);
	assert.equal(unconfirmedCount(second), 0);

	// An old report without the field is tolerated.
	const legacy = build();
	delete (legacy.devices[0] as Partial<(typeof legacy.devices)[0]>)
		.unconfirmed;
	assert.equal(unconfirmedCount(legacy), 0);
});
