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
  mismatch count of the last report.

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
sync is not checked by this plugin.

## How it works

- File hash: HMAC-SHA256 of the file content, keyed by a key derived from the LiveSync
  passphrase (PBKDF2, fixed salt), so hashes cannot be checked without the passphrase.
- Manifest: JSON with the device id, name, creation time and, per file, hash, size and
  modification time. It is encrypted with AES-256-GCM under a key derived from the
  passphrase by PBKDF2 with a random 16-byte salt and a random 12-byte IV; the container is
  `[version 1][salt][iv][ciphertext]`.
- Bucket layout: `<bucketPrefix>_integrity/<deviceId>.json`. LiveSync's journal receiver
  ignores keys that start with `_`, which keeps the manifests out of its journal replay.
  LiveSync's "reset bucket" maintenance deletes everything under the prefix, manifests
  included; they are republished at the next check.
- Transport: AWS Signature Version 4 implemented with WebCrypto, sent through Obsidian's
  `requestUrl`, so it works on Android and does not need CORS on the bucket. Path-style and
  virtual-host addressing and LiveSync's custom headers are honoured.
- Device id: 8 random bytes, generated once and kept in the plugin's `data.json`.

## Limits

- It reads LiveSync's settings through an undocumented internal
  (`app.plugins.plugins["obsidian-livesync"].settings`). A LiveSync update may rename a
  field; the plugin then reports the missing field and does nothing.
- A check hashes the whole vault, so on a large vault it takes a while and reads every
  file. Keep the interval reasonable; each check costs one PUT, one LIST and one GET per
  other device.
- Modification times decide only whether a file has settled, never which side is right.
- The plugin does not compare LiveSync's hidden-file or plugin-settings sync.

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
