import assert from "node:assert/strict";
import { test } from "node:test";
import {
	effectiveQuietMinutes,
	isRunDue,
	MOBILE_QUIET_MINUTES,
	RETRY_MS,
} from "../src/schedule";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_800_000_000_000;

const base = {
	intervalHours: 6,
	quietMinutes: 10,
	lastRunAt: NOW - 7 * HOUR,
	lastAttemptAt: NOW - 7 * HOUR,
	lastChangeAt: NOW - HOUR,
};

test("a due, quiet schedule runs", () => {
	assert.equal(isRunDue(base, NOW), true);
});

test("not due before the interval has passed", () => {
	assert.equal(isRunDue({ ...base, lastRunAt: NOW - 5 * HOUR }, NOW), false);
});

test("waits for the quiet period after a vault change", () => {
	assert.equal(
		isRunDue({ ...base, lastChangeAt: NOW - 5 * MINUTE }, NOW),
		false,
	);
	assert.equal(
		isRunDue({ ...base, lastChangeAt: NOW - 11 * MINUTE }, NOW),
		true,
	);
});

test("a failed attempt backs off instead of retrying every minute", () => {
	const failed = { ...base, lastAttemptAt: NOW - MINUTE };
	assert.equal(isRunDue(failed, NOW), false);
	assert.equal(isRunDue(failed, NOW + RETRY_MS - MINUTE - 1), false);
	assert.equal(isRunDue(failed, NOW + RETRY_MS - MINUTE), true);
});

test("the back-off never exceeds the interval", () => {
	const short = {
		...base,
		intervalHours: 0.25,
		lastRunAt: NOW - HOUR,
		lastAttemptAt: NOW - 16 * MINUTE,
	};
	assert.equal(isRunDue(short, NOW), true);
});

test("the quiet period is capped on mobile and untouched on desktop", () => {
	assert.equal(effectiveQuietMinutes(10, false), 10);
	assert.equal(effectiveQuietMinutes(10, true), MOBILE_QUIET_MINUTES);
	assert.equal(effectiveQuietMinutes(1, true), 1);
});
