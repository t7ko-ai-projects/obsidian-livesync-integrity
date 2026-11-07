# Changelog

## 0.1.0

- Hardening after a security review: device id kept in device-local storage, device id
  bound to the manifest ciphertext, padded manifests, caps on manifest size, count and
  listing pages, stale, rolled-back and vanished manifests reported as problems, failed
  scheduled runs back off, S3 error bodies reduced to code and message, http(s)-only
  endpoints.

- First release: encrypted per-device manifests under `_integrity/` in the LiveSync bucket,
  scheduled and manual checks, a report modal, a status-bar count, and notices for new
  mismatches. Credentials are taken from the running LiveSync plugin.
