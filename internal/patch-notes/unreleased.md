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

## 2026-09-24 — Confirmed root cause of the Linux (Steam Deck) blank-screen bug

No code fix yet, but the real cause is now confirmed (see `BUGS.md`): the
AppImage bundles its own `libwayland-*` libraries, which conflict with
SteamOS's own Mesa/EGL stack (`EGL_BAD_PARAMETER`). An earlier guess (a
WebKitGTK DMA-BUF renderer bug, fixable with an env var) was wrong - noting
that here since it was logged as the working hypothesis in this same file
yesterday.

Confirmed-working manual fix: extract the AppImage, remove the bundled
`libwayland-client.so.0`/`libwayland-cursor.so.0`/`libwayland-server.so.0`/
`libwayland-egl.so.1`, launch `./AppRun` directly. Real fix still needed at
the build step (exclude these libs from the AppImage bundle in
`release.yml`, or a custom `AppRun` that removes them before exec) - not
yet implemented.
