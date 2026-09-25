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

## 2026-09-25 — Fully offline/local-only data model: catalog + prices + icons, driven by real Discord feedback

Three real reports: no-internet = hard error, prices feel slow (kept
re-fetching live), icons broken outright (warframe.market's own icon CDN
apparently changed). Fixed all three - see `BUGS.md` (3 new rows) and
`DEVLOG.md`'s new "Offline / local data model" section for the full
writeup. Short version:

- Item catalog gained disk persistence (`items-cache.json` + a committed
  `items-cache.seed.json`) mirroring the pricing cache's proven shape -
  `GET /api/items` never touches the network and never rejects now.
- All automatic background refreshing removed (catalog's hourly re-fetch,
  prices' weekly resweep) - one manual **"Update Data"** button
  (`POST /api/update-data`, replaces the old prices-only
  `POST /api/refresh-prices`) does catalog + prices + icons together.
  `GET /api/status` bumped to `schemaVersion: 2` (new `catalog`/`icons`
  blocks) - **launcher updated to match** (`KNOWN_STATUS_SCHEMA_VERSION`
  1 -> 2), needs a new launcher build to actually reach users, otherwise
  an already-installed launcher shows "unknown" status against a server
  running this version.
- Icons completely re-sourced off warframe.market onto local, offline
  extraction via Warframe-Exporter reading a real client's
  `Cache.Windows` directly - `MARKET_EMULATOR_CACHE_DIR`/
  `MARKET_EMULATOR_EXPORTER_PATH` env vars, off by default, graceful
  placeholder-icon fallback for anyone who doesn't set it up. **The
  extraction tool itself is NOT bundled in this repo** (Puxtril/
  Warframe-Exporter has no LICENSE file - no redistribution rights) -
  documented as a manual opt-in setup step in `DEVLOG.md` instead.
- Real coverage on a Windows extraction run: Prime sets 100%, Arcanes
  100%, Relics 96.6%, Mods 95.7%, individual Prime part blueprints 0% (no
  icon exists anywhere in Public Export for those - matches real in-game
  behavior, not a gap).
- **Linux/Steam Deck path (the `.AppImage` build) is unverified on real
  hardware** - see `BUGS.md`'s new row, which explicitly calls out not
  cutting a real release until this AND the pre-existing Steam Deck
  blank-screen fix (entry below, also unverified in real CI/hardware) get
  tested together on an actual Steam Deck.
- No version bumps in this pass (regular `master` commit, not a release
  cut) - see the release walkthrough in `../../CLAUDE.md` for what needs
  bumping when this is actually ready to tag.

## 2026-09-24 — Confirmed root cause of the Linux (Steam Deck) blank-screen bug

No code fix yet, but the real cause is now confirmed (see `BUGS.md`): the
AppImage bundles its own `libwayland-*` libraries, which conflict with
SteamOS's own Mesa/EGL stack (`EGL_BAD_PARAMETER`). An earlier guess (a
WebKitGTK DMA-BUF renderer bug, fixable with an env var) was wrong - noting
that here since it was logged as the working hypothesis in this same file
yesterday.

Confirmed-working manual fix: extract the AppImage, remove the bundled
`libwayland-client.so.0`/`libwayland-cursor.so.0`/`libwayland-server.so.0`,
launch `./AppRun` directly.

## 2026-09-24 — Automated the Steam Deck AppImage fix into the release pipeline

`.github/workflows/release.yml` gets a new `fix-linux-appimage` job that
runs after both platform builds finish: downloads the AppImage tauri-action
just published, extracts it, removes the three conflicting `libwayland-*`
libs, repacks with `appimagetool`, **re-signs it with the existing Tauri
signing key**, and patches both Linux entries in `latest.json`
(`linux-x86_64` and `linux-x86_64-appimage`) to the new signature.

The re-sign step is load-bearing, not optional - the original signature only
covers the original bytes, so shipping the patched file without it would
have broken the Linux auto-updater for every future update.

Also added a `workflow_dispatch` trigger (`tag` input) so this job can be
tested against an already-published release without cutting a new tag.

- **Untested in real CI** - YAML syntax validated (`python -c "import
  yaml..."`), and the `needs`/`if`/matrix logic was traced through by hand,
  but this has not actually run. `actionlint` wasn't available here to
  check GitHub Actions-specific semantics beyond plain YAML syntax.
- **Recommended before trusting this on a real release**: trigger it via
  `workflow_dispatch` against the existing `v1.2.0` tag first, then verify
  by hand that the re-uploaded AppImage actually launches on a real Steam
  Deck and that the updater still accepts the patched `latest.json`
  - this modifies a live, already-published release's assets, so it's
  worth watching the first run closely rather than trusting it blind.
- See `.github/workflows/release.yml` for the implementation, `BUGS.md`
  (2026-09-24, Launcher/Steam Deck) for the confirmed root cause.
