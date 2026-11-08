# Changelog

## 0.1.5

- On a phone an overdue check starts the moment Obsidian opens or returns to the
  foreground, with no quiet period, since the app is rarely open for long.

## 0.1.4

- A file with the same content under different paths on the two devices is reported as
  "moved, not yet confirmed" instead of two mismatches.
- On a phone the scheduled check waits at most 2 minutes of quiet, ticks every 15 s and
  also runs when Obsidian returns to the foreground, so the phone actually publishes
  manifests.

## 0.1.3

- Clicking the status bar item opens the integrity report.

## 0.1.2

- The daily digest no longer resets its baseline when shown. "Mark as seen" in the digest
  window saves the new baseline; closing the window keeps the digest, and the automatic
  window comes back once a day until it is marked as seen.

## 0.1.1

- Fix "Not usable: Self-hosted LiveSync is not loaded or has no settings" with LiveSync
  1.0.x, which keeps its settings on the core object rather than on the plugin object.
  Both places are now read.

## 0.1.0

- Daily digest (off by default): a modal with the files renamed, added, modified and
  deleted since the digest was last shown, attributed to the device whose manifest carries
  the change, with click-through to LiveSync's document history. Scan-based baseline in
  `data.json`; nothing written to the vault or the bucket.

- Hardening after a security review: device id kept in device-local storage, device id
  bound to the manifest ciphertext, padded manifests, caps on manifest size, count and
  listing pages, stale, rolled-back and vanished manifests reported as problems, failed
  scheduled runs back off, S3 error bodies reduced to code and message, http(s)-only
  endpoints.

- First release: encrypted per-device manifests under `_integrity/` in the LiveSync bucket,
  scheduled and manual checks, a report modal, a status-bar count, and notices for new
  mismatches. Credentials are taken from the running LiveSync plugin.
