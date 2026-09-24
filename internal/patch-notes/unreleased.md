# Unreleased — since v1.2.0

Running log of everything merged to `master` since the last tagged
release, so a future release doesn't require backtracking through
`git log`/DEVLOG.md to reconstruct what's actually pending. Newest
first. Each entry is terse — full root-cause writeups live in
[`DEVLOG.md`](../../DEVLOG.md), the fast-scan bug index in
[`BUGS.md`](../../BUGS.md); this file exists to answer "what's queued
for the next release" specifically, and to draft that release's notes
from when the time comes.

**When a release ships**: rename this file to the version that just
shipped (e.g. `v1.2.1.md`) and create a fresh `unreleased.md` — see
`internal/patch-notes/` for the full history once more than one exists.

---

## 2026-09-24 — Logged a real Linux (Steam Deck) blank-screen report

No code change yet - logged a user report (blank webview on launch, AppImage
window opens fine otherwise) in `BUGS.md` under "Known / open" with a working
hypothesis (WebKitGTK DMA-BUF renderer bug on Steam Deck's AMD/Mesa combo) and
a diagnostic env var to test. Will follow up with an actual fix (likely baking
the env var into the AppImage's launch wrapper) once the reporter confirms the
cause.
