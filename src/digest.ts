/**
 * The daily digest: what changed in the vault since the baseline was saved.
 * Scan-based, not event-based, so missed days cost nothing. Pure functions
 * here; the scan and the remote fetch are in `digest-run.ts`.
 */
import { fileEntry, type Manifest, type ManifestEntry } from "./manifest";

/** The last scan the digest was shown for; kept in data.json. */
export interface DigestBaseline {
	savedAt: number;
	files: Record<string, ManifestEntry>;
}

export type DigestKind = "renamed" | "added" | "modified" | "deleted";

export interface DigestEntry {
	kind: DigestKind;
	path: string;
	/** For a rename: the path the file had in the baseline. */
	oldPath?: string;
	/** Current size, or the baseline size for a deleted file. */
	size: number;
	/** Current minus baseline size; absent for added, deleted and renamed. */
	sizeDelta?: number;
	/** Current mtime, or the baseline mtime for a deleted file. */
	mtime: number;
	/** Name of the other device whose manifest carries the change, if any. */
	device?: string;
}

export const DIGEST_KINDS: DigestKind[] = [
	"renamed",
	"added",
	"modified",
	"deleted",
];

/** True when `savedAt` falls on an earlier local calendar day than `now`. */
export function isEarlierLocalDay(savedAt: number, now: number): boolean {
	const a = new Date(savedAt);
	const b = new Date(now);
	if (a.getFullYear() !== b.getFullYear()) {
		return a.getFullYear() < b.getFullYear();
	}
	if (a.getMonth() !== b.getMonth()) {
		return a.getMonth() < b.getMonth();
	}
	return a.getDate() < b.getDate();
}

function deviceLabel(m: Manifest): string {
	return m.deviceName || m.deviceId;
}

/** The device whose manifest, newer than the baseline, holds this exact
 * content at this path. */
function attributePresent(
	remotes: Manifest[],
	path: string,
	hash: string,
	baselineSavedAt: number,
): string | undefined {
	for (const remote of remotes) {
		const entry = fileEntry(remote.files, path);
		if (
			entry !== undefined &&
			entry.h === hash &&
			entry.m > baselineSavedAt &&
			remote.createdAt > baselineSavedAt
		) {
			return deviceLabel(remote);
		}
	}
	return undefined;
}

/** The device whose manifest, newer than the baseline, lacks the file. */
function attributeAbsent(
	remotes: Manifest[],
	path: string,
	baselineSavedAt: number,
): string | undefined {
	for (const remote of remotes) {
		if (
			remote.createdAt > baselineSavedAt &&
			fileEntry(remote.files, path) === undefined
		) {
			return deviceLabel(remote);
		}
	}
	return undefined;
}

/**
 * Diff the live scan against the baseline. A deleted path whose hash matches
 * an added path becomes one rename. Sorted by mtime, newest first.
 */
export function computeDigest(
	baseline: DigestBaseline,
	scan: Record<string, ManifestEntry>,
	remotes: Manifest[] = [],
): DigestEntry[] {
	const entries: DigestEntry[] = [];
	const addedByHash = new Map<string, string[]>();
	for (const path of Object.keys(scan)) {
		const now = fileEntry(scan, path);
		if (now === undefined) {
			continue;
		}
		const before = fileEntry(baseline.files, path);
		if (before === undefined) {
			const list = addedByHash.get(now.h) ?? [];
			list.push(path);
			addedByHash.set(now.h, list);
		} else if (before.h !== now.h) {
			entries.push({
				kind: "modified",
				path,
				size: now.s,
				sizeDelta: now.s - before.s,
				mtime: now.m,
				device: attributePresent(
					remotes,
					path,
					now.h,
					baseline.savedAt,
				),
			});
		}
	}
	const renamedTo = new Set<string>();
	for (const path of Object.keys(baseline.files)) {
		const before = fileEntry(baseline.files, path);
		if (before === undefined || fileEntry(scan, path) !== undefined) {
			continue;
		}
		const candidates = addedByHash.get(before.h);
		const newPath = candidates?.shift();
		if (newPath !== undefined) {
			renamedTo.add(newPath);
			const now = fileEntry(scan, newPath);
			entries.push({
				kind: "renamed",
				path: newPath,
				oldPath: path,
				size: now?.s ?? before.s,
				mtime: now?.m ?? before.m,
				device: attributePresent(
					remotes,
					newPath,
					before.h,
					baseline.savedAt,
				),
			});
		} else {
			entries.push({
				kind: "deleted",
				path,
				size: before.s,
				mtime: before.m,
				device: attributeAbsent(remotes, path, baseline.savedAt),
			});
		}
	}
	for (const paths of addedByHash.values()) {
		for (const path of paths) {
			if (renamedTo.has(path)) {
				continue;
			}
			const now = fileEntry(scan, path);
			if (now === undefined) {
				continue;
			}
			entries.push({
				kind: "added",
				path,
				size: now.s,
				mtime: now.m,
				device: attributePresent(
					remotes,
					path,
					now.h,
					baseline.savedAt,
				),
			});
		}
	}
	entries.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : 1));
	return entries;
}

/** Entries of one kind, in digest order. */
export function digestGroup(
	entries: DigestEntry[],
	kind: DigestKind,
): DigestEntry[] {
	return entries.filter((e) => e.kind === kind);
}
