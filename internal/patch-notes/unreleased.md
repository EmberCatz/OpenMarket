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

- **Fixed: Owned tab empty until page reload / before login.** The script
  polled `inventory.php` before the game logged in (SNS 500 "missing
  accountId", every 5s) - it now waits quietly for login, and also checks
  the snapshot POST's HTTP status. The frontend no longer caches the
  owned map for the whole session (5s reuse, refetch after) and shows an
  "Inventory not received yet" hint when the server has no snapshot.
  Needs a `server/`-side update? No - only `public/app.js` and
  `scripts/Market Sync.pluto` changed; existing installs must delete and
  re-Install the script (Install never overwrites). No launcher rebuild.
  Script change unverified in-game. See BUGS.md / DEVLOG.md.

- **Backend hardening** (server-side only, no launcher rebuild): a
  malformed inventory snapshot can no longer crash the server (per-entry
  validation + every async route wrapped + a catch-all error handler);
  `getItems()` is memoized (per-row lookups ~70 ms -> ~15 ms; identical
  output); `POST /api/order` rejects Infinity/fractional/negative/string
  values; finished orders are pruned; an empty-inventory snapshot (`[]`)
  is accepted. Needs a `server/` update on existing installs (files:
  `itemsCache.ts`, `localIcons.ts`, `inventorySnapshot.ts`, `routes.ts`,
  `orderQueue.ts`, `index.ts`). Found by a local stress harness that is not
  part of this repo. See BUGS.md / DEVLOG.md.

- **Launcher: "updated, but data isn't" notice.** After the launcher
  updates itself, the Dashboard now shows a dismissible warning that
  updating the app doesn't download new data and the user still has to
  click Update Data in OpenMarket. Stays until dismissed; not shown on a
  fresh install. **Needs a launcher rebuild/release** to reach users
  (frontend-only change, `launcher/src/App.tsx` + `lib/config.ts`). See
  DEVLOG.md.

- **Launcher: version shown in the header** ("OpenMarket Launcher v1.3.0"), so a bug report can name the exact build. Same launcher-rebuild note as above; `launcher/src/App.tsx` + `App.css`.
