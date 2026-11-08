# LiveSync Integrity (t7)

An Obsidian plugin that checks whether the devices sharing one
[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) S3 bucket really hold
the same files. Each device publishes an encrypted manifest of file hashes to the bucket;
every device compares its own vault with the others' manifests and reports the files that
differ, exist only here, or exist only there.

The plugin never writes a vault file and never touches LiveSync's journal objects. It only
reads the vault, writes its own manifest under `_integrity/` in the bucket, and reads the
other manifests there.

## Why

LiveSync's S3 "journal" mode has no cross-device verification. Its receiver lists the bucket
after the newest journal file it has already received, so a journal file that is briefly
invisible in a listing (eventually consistent storage, or clock skew between devices) is
skipped for good on that device, with no warning. The vaults then drift apart silently.
This plugin makes the drift visible.

## Requirements

- Obsidian 1.7.2 or newer, desktop or Android.
- Self-hosted LiveSync in **Object Storage (S3) mode** with **end-to-end encryption on**.
  The plugin takes the bucket connection and the E2EE passphrase from the running LiveSync
  plugin at run time; it stores no credentials of its own. If LiveSync is missing, not in
  S3 mode, or any of those settings is empty, the check refuses to run and says why.
- The S3 credentials must allow `PutObject`, `GetObject` and `ListObjectsV2` under
  LiveSync's bucket prefix (the same rights LiveSync itself needs).

## Installation

Not in the community plugin list. Either:

- **BRAT**: add this repository in BRAT; it installs the latest GitHub release.
- **By hand**: download `main.js`, `manifest.json` and `styles.css` from the latest release
  into `<vault>/.obsidian/plugins/t7-livesync-integrity/` and enable the plugin.

Install it in every vault copy that takes part in the sync. A device without the plugin
publishes no manifest and is simply absent from the reports.

## Usage

- **Settings → LiveSync Integrity (t7)**: give the device a name, choose the interval
  (default every 6 hours), the quiet period the vault must be unchanged for before a
  scheduled run (default 10 minutes), the grace window (default 30 minutes), exclusions,
  and whether to be notified about new mismatches.
- **Command "Run integrity check now"** runs a check immediately.
- **Command "Show integrity report"** opens the last report. The status bar shows the
  mismatch count of the last report; clicking it opens the report too.
- **Command "Show daily digest"** opens the digest of vault changes (see below).

A scheduled check also runs when the plugin loads after the interval has passed (for a PC
that is not opened every day), once the vault has been quiet for the quiet period.

### What a report means

For every other device that has published a manifest, the report lists:

- **Different content**: the file exists on both devices with different content.
- **Only on this device** / **Only on that device**: one side lacks the file.
- The manifest's age: a stale manifest (the device has not run the check for a long time)
  compares your current vault with an old snapshot, so treat its mismatches with care.

A file is reported only when both sides have had the chance to settle: its modification
time must be older than the grace window, counted back from the older of the two manifests.
Files changed more recently are counted as "still inside the grace window" and will show
up in a later check if they stay different. A file deleted on one device shows as "only on
that device" until the other device syncs the deletion and publishes a new manifest.

The report's "Problems" list and the status bar's "problems" flag cover everything that
makes a result suspect rather than a plain mismatch:

- a manifest older than three check intervals (that device has stopped checking);
- a manifest that went back in time since the last check, or a device whose manifest
  disappeared from the bucket (someone restored or deleted bucket objects; use "Forget
  all" under Known devices after retiring a device);
- manifests that could not be decrypted, were too large, or were not manifests at all.

"No other device" is also not an all-clear: nothing was compared.

### Daily digest

Off by default; turn on **Daily digest** in the settings. On the first start of each day
(local time, about 30 seconds after Obsidian opens, once the vault is indexed), and
whenever the command "Show daily digest" runs, the plugin scans the vault with the same
keyed hash the check uses and shows a window with the files **renamed or moved**, **added**,
**modified** and **deleted** since the digest was last marked as seen. Each entry shows the path,
the size (and the size change for a modified file), the modification time and, where
another device's manifest newer than the last digest carries the same change, the name of
that device. A rename is a deleted path whose content reappeared under a new path, so it is
detected only when the content is unchanged; a note that was moved and edited shows as
deleted plus added. Entries are sorted newest first within each group.

Click an entry to open the file and LiveSync's document history (its revision slider and
diff) for it. A deleted file cannot be opened, so its entry opens LiveSync's file history
picker instead, where you pick the file yourself. Without LiveSync the entry just opens
the file and a notice says history is unavailable.

Viewing the digest changes nothing: close it with X or Escape and the same digest can be
reopened any number of times. **Mark as seen** saves the current scan as the new baseline,
so the next digest starts from now. The automatic daily window appears once a day (it does
not return at every restart) until the digest is marked as seen.

The digest compares scans, not events: it does not matter how many days the vault was
closed, and the first run only records the baseline and says so. The baseline (path, hash,
size, mtime per file) lives in the plugin's `data.json`; "Reset baseline" in the settings
drops it. The digest writes nothing to the vault or the bucket; it reads the other devices'
manifests only to attribute changes.

### Repairing a mismatch

The plugin only reports; it changes nothing. To repair, look at both copies of the file
first (the content that differs may be a conflict LiveSync kept on one side). To make a
device receive everything again, use LiveSync's **Settings → Maintenance → "Reset journal
received history"** on the device that is missing changes; it replays all journal files
from the bucket. For a file that exists only on one device, saving it again (or touching
it) on that device makes LiveSync send it again.

## Exclusions

One regular expression per line, tested against the vault-relative path. The vault's
configuration folder (`.obsidian` by default) is always excluded; LiveSync's hidden-file
sync is not checked by this plugin. Keep patterns simple: a pattern with nested repetition
such as `(a+)+$` can take exponential time on some paths and stall the check.

## How it works

- File hash: HMAC-SHA256 of the file content, keyed by a key derived from the LiveSync
  passphrase (PBKDF2, fixed salt), so hashes cannot be checked without the passphrase.
- Manifest: JSON with the device id, name, creation time and, per file, hash, size and
  modification time, padded with spaces to a multiple of 4 KiB so the object size does not
  reveal the file count. It is encrypted with AES-256-GCM under a key derived from the
  passphrase by PBKDF2 (600 000 iterations) with a random 16-byte salt and a random
  12-byte IV; the device id is the authenticated associated data, so a manifest copied
  under another device's key does not decrypt. The container is
  `[version 1][salt][iv][ciphertext]`.
- Bucket layout: `<bucketPrefix>_integrity/<deviceId>.json`. LiveSync's journal receiver
  ignores keys that start with `_`, which keeps the manifests out of its journal replay.
  LiveSync's "reset bucket" maintenance deletes everything under the prefix, manifests
  included; they are republished at the next check.
- Transport: AWS Signature Version 4 implemented with WebCrypto, sent through Obsidian's
  `requestUrl`, so it works on Android and does not need CORS on the bucket. Path-style and
  virtual-host addressing and LiveSync's custom headers are honoured.
- Device id: 8 random bytes in hex, generated once and kept in Obsidian's device-local
  storage, not in `data.json`, so LiveSync's customisation sync cannot copy it to another
  device (two devices with one id would each ignore the other's manifest).
- Limits: manifests above 16 MB are not downloaded, at most 64 other manifests are
  compared, a listing is followed for at most 100 pages, and only keys named
  `<16 hex digits>.json` directly under `_integrity/` count as manifests. S3 error
  responses are reduced to their error code and a short message before they reach a
  notice or the report.

## Limits

- It reads LiveSync's settings through an undocumented internal
  (`app.plugins.plugins["obsidian-livesync"].core.settings`, or `.settings` on older versions). A LiveSync update may rename a
  field; the plugin then reports the missing field and does nothing.
- A check hashes the whole vault, so on a large vault it takes a while and reads every
  file. Keep the interval reasonable; each check costs one PUT, one LIST and one GET per
  other device.
- Modification times decide only whether a file has settled, never which side is right.
- After a failed scheduled run (offline, bucket down) the plugin waits an hour, or one
  interval if that is shorter, before trying again, and shows the failure notice once.
- The plugin does not compare LiveSync's hidden-file or plugin-settings sync.
- The digest's history links depend on two LiveSync command ids
  (`obsidian-livesync:livesync-history`, `obsidian-livesync:livesync-filehistory`, checked
  against LiveSync v1.0.45). If a LiveSync update renames them, the entries still open the
  file and a notice says history is unavailable.

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
npm run build
```

`npm run build` writes `build/main.js`, `build/manifest.json` and `build/styles.css`; copy
`.env.example` to `.env` to have them copied into a test vault as well. Releases:
`node scripts/release-github.mjs` (see its header). The manual test plan is in
[docs/MANUAL-TEST-PLAN.md](docs/MANUAL-TEST-PLAN.md).

## License

MIT.
