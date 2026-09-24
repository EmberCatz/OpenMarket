# Unreleased — since v1.1.1

Running log of everything merged to `master` since the last tagged
release, so a future release doesn't require backtracking through
`git log`/DEVLOG.md to reconstruct what's actually pending. Newest
first. Each entry is terse — full root-cause writeups live in
[`DEVLOG.md`](../../DEVLOG.md), the fast-scan bug index in
[`BUGS.md`](../../BUGS.md); this file exists to answer "what's queued
for the next release" specifically, and to draft that release's notes
from when the time comes.

**When a release ships**: rename this file to the version that just
shipped (e.g. `v1.1.2.md`) and create a fresh `unreleased.md` — see
`internal/patch-notes/` for the full history once more than one exists.

---

## 2026-09-24 — "Check for Issues" launcher diagnostic

Added a button (Help tab → Troubleshooting) that checks whether the
user's `server/` folder is actually running current code, without
walking them through a manual `git log` check. `GET /api/status` now
reports `serverVersion` (from `server/package.json`, read at server
startup); the launcher compares it against its own build version and
reports a plain-language mismatch with the fix (`git pull` in the server
folder, then restart).

- **Needs a launcher rebuild to reach users** (frontend + Rust ACL
  change); the server-side `serverVersion` field itself takes effect on
  a plain server restart.
- `server/package.json`'s version is now a fourth file to bump alongside
  every release, in lockstep with the launcher's three — see the
  updated release-walkthrough note in `../CLAUDE.md`.
- Verified: `cargo check` and `tsc --noEmit` both clean, the new
  `core:app:default` ACL permission resolves without a schema error, and
  a scratch-port curl confirms `/api/status` returns `serverVersion`.
  **Not verified: an actual click-through in a running launcher window**
  (no GUI automation available for a native app) — wants a real manual
  test before shipping.
- See `DEVLOG.md` under "Desktop launcher" for the full writeup.
