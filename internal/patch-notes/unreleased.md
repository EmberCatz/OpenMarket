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
