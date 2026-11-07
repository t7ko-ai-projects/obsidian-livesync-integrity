# Changelog

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
