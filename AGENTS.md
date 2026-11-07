# Notes for AI coding agents: LiveSync Integrity

An Obsidian plugin (TypeScript, esbuild, no runtime dependencies) that compares file hashes
across the devices sharing one Self-hosted LiveSync S3 bucket. Local, non-versioned details
are in `AGENTS.local.md` (imported by `CLAUDE.md`); keep anything personal there.

## Rules

- Write in English. No emoji. Braces on every control-flow body. ESLint and Prettier
  (`npm run lint:fix`, `npm run format`); the pre-commit hook runs lint-staged.
- The plugin must never write a vault file and must never write to any bucket key outside
  `<bucketPrefix>_integrity/`. Keep it that way: every S3 write goes through
  `S3Client.put` with a key from `manifestKey()`.
- Desktop and Android: WebCrypto and Obsidian's `requestUrl` only, no Node APIs and no
  `fetch` (CORS). `esbuild.config.mjs` marks Node built-ins external so a stray import
  fails at load time instead of silently bundling.
- Credentials come from LiveSync at run time (`src/livesync-credentials.ts`) and are never
  persisted or logged. Reading `app.plugins.plugins["obsidian-livesync"].settings` is an
  undocumented internal; validate every field and fail with a reason.
- Never test against a real vault or a real bucket; the manual plan uses a test vault and a
  test bucket (`docs/MANUAL-TEST-PLAN.md`). `npm test` runs on synthetic data only.

## Layout

| Path                                  | Role                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `src/main.ts`                         | Plugin lifecycle, commands, scheduler tick, status bar, notices.        |
| `src/check.ts`                        | One run: hash, upload own manifest, list, download, compare.            |
| `src/manifest.ts`                     | Manifest format, exclusions, build, encrypt/decrypt/validate.           |
| `src/compare.ts`                      | Pure comparison and mismatch counting/keys.                             |
| `src/crypto/manifest-crypto.ts`       | PBKDF2 key derivation, HMAC file hash, AES-GCM container.               |
| `src/s3/sigv4.ts`, `src/s3/client.ts` | SigV4 signer (WebCrypto) and PUT/GET/LIST over `requestUrl`.            |
| `src/livesync-credentials.ts`         | Reads and validates LiveSync's settings.                                |
| `src/settings.ts`, `src/ui/`          | Plugin settings, settings tab, report modal.                            |
| `tests/`                              | Node test runner through esbuild (`test.config.mjs`), Obsidian stubbed. |
| `scripts/release-github.mjs`          | BRAT-compatible GitHub release (tag = version, three assets).           |

## Design decisions

- **Bucket key `_integrity/`, not `integrity/`.** LiveSync's journal receiver
  (commonlib `JournalSyncCore.ts`) lists everything under the prefix after its last
  received key and treats every key as a journal pack unless it starts with `_`
  (`isJournalKey`). Anything else would be downloaded as a journal and fail.
- **Grace window counted from the older manifest.** A file is flagged only when its mtime
  on both sides is older than `min(localCreatedAt, remoteCreatedAt) - grace`; otherwise the
  other device may simply not have scanned since the change. Mtimes decide only "settled",
  never which side is right (LiveSync preserves them, but Android may not).
- **Hash is HMAC keyed from the passphrase** (PBKDF2 with a fixed salt so all devices
  agree), and the manifest is AES-256-GCM under a PBKDF2 key with a random salt and IV
  prefixed (`[1][salt 16][iv 12][ct]`). A manifest that fails to decrypt is reported as a
  problem for that device and skipped.
- **Scheduling survives missed days**: on every minute tick, a run is due when
  `now - lastRunAt >= interval`, and it waits until the vault has been quiet (no vault
  event) for the quiet period; plugin load counts as a change so LiveSync's startup sync
  settles first.
- **Config folder always excluded** through `vault.configDir` (the ESLint rule forbids a
  literal `.obsidian`); `vault.getFiles()` does not list it anyway.
- **Report state** (`lastReport`, `knownMismatchKeys`) lives in `data.json`; a notice fires
  only for mismatch keys not seen in the previous report.

## Checks before a commit

`npm test`, `npm run lint`, `npm run format:check`, `npm run build`, `git diff --check`,
and a scan of the staged diff for personal details (paths, hostnames, bucket names, keys).
