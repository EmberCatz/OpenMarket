# Unreleased — since v1.0.1

Running log of everything merged to `master` since the last tagged
release, so a future release doesn't require backtracking through
`git log`/DEVLOG.md to reconstruct what's actually pending. Newest
first. Each entry is terse — full root-cause writeups live in
[`DEVLOG.md`](../../DEVLOG.md), the fast-scan bug index in
[`BUGS.md`](../../BUGS.md); this file exists to answer "what's queued
for the next release" specifically, and to draft that release's notes
from when the time comes.

**When a release ships**: rename this file to the version that just
shipped (e.g. `v1.0.2.md`) and create a fresh `unreleased.md` — see
`internal/patch-notes/` for the full history once more than one exists.

---

## 2026-09-20 — Weapon Prime parts/sets added

Prime Warframe parts were the only Prime support until now (README/BUGS.md/
DEVLOG.md all listed weapon Primes as a known gap). Added alongside the
existing Warframe implementation rather than replacing it: a new
`server/tools/generate-prime-weapon-sets.js` (mirrors
`generate-prime-sets.js`) builds `prime-weapon-sets.json` from
`ExportRecipes.json`, and `itemsCache.ts`'s `buildPrimeItems()` was
generalized into `buildPrimeCategoryItems()` so both Warframe and weapon
sets share one code path.

Unlike Warframes (always exactly 4 parts, needing a two-stage
finished-component → building-Blueprint resolution), a weapon's physical
components are directly tradeable Recipes already, but part count varies
2-4 by weapon type, and a handful of Akimbo pistols need duplicate parts
or a nested copy of an entirely different, already-existing single
Prime's own part set (e.g. Akmagnus Prime = 2 complete Magnus Prime sets
+ its own Link) — all confirmed from source across the 87 real Prime
weapon blueprints in Public Export, not assumed to generalize from the
Warframe shape. `parts` can now legitimately list the same gameRef more
than once (grant-count correctness); both the server's flat catalog rows
and the frontend's parts-accordion (`buildDisplayRows()` in `app.js`)
dedupe that for display while the actual grant list keeps every
duplicate.

- No launcher rebuild needed — server/frontend-only change.
- Reuses the already-proven `Recipes`-category grant/sell mechanism
  (`Market Sync.pluto` needed zero changes) — verified via a scratch-port
  curl pass: `/api/items` resolved 85 of the 87 candidate weapon sets
  against the live warframe.market bulk list (2 don't have a real
  listing and are silently skipped, same as any unresolvable Warframe
  set), and order creation succeeded for both a plain weapon part and the
  8-part Akmagnus Prime Set. **Not yet confirmed with a real in-game
  Foundry build** — see DEVLOG.md's "Known limitations".
- See `DEVLOG.md` under "Scope, in detail" and "Confirmed HTTP
  mechanics"; `README.md`'s Features/Known limitations updated to drop
  the "Warframes only" caveat.

## 2026-09-20 — Homebrew/Linuxbrew npm install fix

`install_server_deps` was resolving npm's CLI entry point manually on
*every* platform, but that workaround only exists to solve a
Windows-only problem (`Command::new("npm")` can't spawn a `.cmd` batch
file). On Homebrew, npm lives somewhere with no fixed relative path to
node's own directory, so the guessed Unix fallback never matched and
install failed outright. Scoped the manual resolver to
`#[cfg(target_os = "windows")]`; Unix now spawns `npm` directly via
`$PATH`, which already worked fine there.

- Needs a launcher rebuild to reach users.
- Windows branch re-verified with `cargo check`; Unix branch not
  compiled on this machine (no Linux Rust target here) — worth a real
  Linux smoke test before/soon after this ships.
- `a854db0`, `BUGS.md` row 2026-09-20, `DEVLOG.md` under "Desktop
  launcher".

## 2026-09-18 — README button ACL fix

Help tab's "Open README" button called `openPath()`, which needs its
own `opener:allow-open-path` permission — `opener:default` only covers
`open_url`. Never granted, so every release through v1.0.1 shows an
ACL error instead of opening the file.

- Needs a launcher rebuild to reach users.
- Permission name verified against Tauri's generated schema; not yet
  build-tested end-to-end (no GUI automation available here).
- `5780632`, `BUGS.md` row 2026-09-18.

## 2026-09-19 — BUGS.md added

New quick-reference bug tracker (fixed / open / known-external-quirks
tables), cross-linked from README.md and DEVLOG.md.

- Docs-only, no launcher rebuild needed.
- `725dfb2`.

## 2026-09-19 — Probe scripts moved to `scripts/probes/`

Copying the whole `scripts/` folder (instead of just
`Market Sync.pluto`) was putting every dev-only diagnostic probe on
equal footing in OpenWF's script-runner UI, and one got run by accident
during a live support conversation. Probes moved to a subfolder so a
whole-folder copy no longer sweeps them in.

- Repo-only change, no launcher rebuild needed.
- `45b142f`, `BUGS.md` row 2026-09-19.
