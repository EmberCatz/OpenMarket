# Unreleased — since v1.3.0

Running log of everything merged to `master` since the last tagged
release, so a future release doesn't require backtracking through
`git log`/DEVLOG.md to reconstruct what's actually pending. Newest
first. Each entry is terse — full root-cause writeups live in
[`DEVLOG.md`](../../DEVLOG.md), the fast-scan bug index in
[`BUGS.md`](../../BUGS.md); this file exists to answer "what's queued
for the next release" specifically, and to draft that release's notes
from when the time comes.

**When a release ships**: rename this file to the version that just
shipped (e.g. `v1.3.1.md`) and create a fresh `unreleased.md` — see
`internal/patch-notes/` for the full history once more than one exists.

---

- **Added `@wfcd/items` CDN as a second icon fallback tier, ahead of
  browse.wf** (local extraction → wfcd CDN → browse.wf → placeholder).
  99.6% coverage of this app's gameRefs against the actively-maintained
  `cdn.warframestat.us` CDN; live-verified via curl. No rebuild-breaking
  change — new `@wfcd/items` devDependency only feeds an offline
  generator script (`server/tools/generate-wfcd-icon-map.js` →
  `server/wfcd-icon-map.json`), not a runtime dependency. Needs a
  `server/` update (new files + `npm install`) to reach a running
  instance, no launcher rebuild. See DEVLOG.md for the full writeup.
