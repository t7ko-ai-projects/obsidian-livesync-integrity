/** Pure comparison of the local manifest with one remote manifest. */
import { fileEntry, type Manifest } from "./manifest";

export interface DeviceReport {
	deviceId: string;
	deviceName: string;
	/** When the remote manifest was created, ms since the epoch. */
	manifestCreatedAt: number;
	/** Age of the remote manifest at comparison time, ms. */
	manifestAgeMs: number;
	/** The manifest is older than the stale limit: its mismatches are suspect. */
	stale: boolean;
	/** Paths present on both sides with different hashes. */
	differing: string[];
	/** Paths present only in the local vault. */
	onlyHere: string[];
	/** Paths present only on the remote device. */
	onlyThere: string[];
	/** Paths skipped because one side changed inside the grace window. */
	pending: number;
	/** Files with the same content under different paths on the two sides
	 * ("old -> new"): a move the other device has not reported yet. Not a
	 * mismatch; it stays here until the move is confirmed or turns out to be
	 * a real difference. */
	moved: string[];
}

export interface IntegrityReport {
	createdAt: number;
	localFileCount: number;
	devices: DeviceReport[];
	/** Human-readable problems that stopped part of the check or that make
	 * the result suspect (stale, rolled back or vanished manifests). */
	errors: string[];
}

export interface CompareOptions {
	now: number;
	graceMs: number;
	/** A remote manifest older than this is marked stale. */
	staleMs?: number;
}

/**
 * Flag only files that both sides had a chance to settle: an mtime must be
 * older than the grace window counted back from the OLDER of the two
 * manifests, otherwise the other device may simply not have scanned yet.
 */
export function compareManifests(
	local: Manifest,
	remote: Manifest,
	options: CompareOptions,
): DeviceReport {
	const cutoff =
		Math.min(local.createdAt, remote.createdAt) - options.graceMs;
	const settled = (mtime: number) => mtime < cutoff;
	const ageMs = Math.max(0, options.now - remote.createdAt);
	const report: DeviceReport = {
		deviceId: remote.deviceId,
		deviceName: remote.deviceName,
		manifestCreatedAt: remote.createdAt,
		manifestAgeMs: ageMs,
		stale: options.staleMs !== undefined && ageMs > options.staleMs,
		differing: [],
		onlyHere: [],
		onlyThere: [],
		pending: 0,
		moved: [],
	};
	const paths = new Set([
		...Object.keys(local.files),
		...Object.keys(remote.files),
	]);
	for (const path of [...paths].sort()) {
		const here = fileEntry(local.files, path);
		const there = fileEntry(remote.files, path);
		if (here && there) {
			if (here.h === there.h) {
				continue;
			}
			if (settled(here.m) && settled(there.m)) {
				report.differing.push(path);
			} else {
				report.pending += 1;
			}
		} else if (here) {
			if (settled(here.m)) {
				report.onlyHere.push(path);
			} else {
				report.pending += 1;
			}
		} else if (there) {
			if (settled(there.m)) {
				report.onlyThere.push(path);
			} else {
				report.pending += 1;
			}
		}
	}
	pairMoves(report, local, remote);
	return report;
}

/**
 * A move keeps the file's mtime, so the grace window does not protect it:
 * the same content missing here and present there under another path is a
 * move one side has not synced yet, not two mismatches. Paired by hash,
 * one to one.
 */
function pairMoves(report: DeviceReport, local: Manifest, remote: Manifest) {
	const thereByHash = new Map<string, string[]>();
	for (const path of report.onlyThere) {
		const hash = fileEntry(remote.files, path)?.h;
		if (hash !== undefined) {
			const list = thereByHash.get(hash) ?? [];
			list.push(path);
			thereByHash.set(hash, list);
		}
	}
	const pairedHere = new Set<string>();
	const pairedThere = new Set<string>();
	for (const path of report.onlyHere) {
		const hash = fileEntry(local.files, path)?.h;
		const match =
			hash === undefined ? undefined : thereByHash.get(hash)?.shift();
		if (match !== undefined) {
			pairedHere.add(path);
			pairedThere.add(match);
			report.moved.push(`${match} -> ${path}`);
		}
	}
	report.onlyHere = report.onlyHere.filter((p) => !pairedHere.has(p));
	report.onlyThere = report.onlyThere.filter((p) => !pairedThere.has(p));
}

export function mismatchCount(report: IntegrityReport): number {
	return report.devices.reduce(
		(n, d) =>
			n + d.differing.length + d.onlyHere.length + d.onlyThere.length,
		0,
	);
}

/** True when something other than mismatches needs attention. */
export function hasProblems(report: IntegrityReport): boolean {
	return report.errors.length > 0 || report.devices.some((d) => d.stale);
}

/** Stable keys for every mismatch, to tell new ones from already seen ones. */
export function mismatchKeys(report: IntegrityReport): string[] {
	const keys: string[] = [];
	for (const d of report.devices) {
		for (const p of d.differing) {
			keys.push(`${d.deviceId}|differ|${p}`);
		}
		for (const p of d.onlyHere) {
			keys.push(`${d.deviceId}|here|${p}`);
		}
		for (const p of d.onlyThere) {
			keys.push(`${d.deviceId}|there|${p}`);
		}
	}
	return keys;
}
