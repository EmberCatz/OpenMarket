# Unreleased — since v1.1.0

Running log of everything merged to `master` since the last tagged
release, so a future release doesn't require backtracking through
`git log`/DEVLOG.md to reconstruct what's actually pending. Newest
first. Each entry is terse — full root-cause writeups live in
[`DEVLOG.md`](../../DEVLOG.md), the fast-scan bug index in
[`BUGS.md`](../../BUGS.md); this file exists to answer "what's queued
for the next release" specifically, and to draft that release's notes
from when the time comes.

**When a release ships**: rename this file to the version that just
shipped (e.g. `v1.1.1.md`) and create a fresh `unreleased.md` — see
`internal/patch-notes/` for the full history once more than one exists.

---

## 2026-09-23 — Fix PayloadTooLargeError on inventory-snapshot POST

`express.json()` had no explicit `limit`, so it fell back to Express's
built-in 100kb cap. `POST /internal/inventory-snapshot` — the full
inventory dump `Market Sync.pluto` reports every poll cycle — grew past
that once Mods, Arcanes, Relics, and Prime Warframe/Weapon parts and
sets were all added, and started failing with
`PayloadTooLargeError: request entity too large` before reaching any
route handler. Set to `10mb`.

- **No launcher rebuild needed** — backend-only change, takes effect on
  a plain server restart.
- Verified with a scratch-port curl (200KB test body): `413` before the
  fix, `400` route-level validation after (i.e. it now reaches the
  handler). [`84b7f17`](https://github.com/EmberCatz/OpenMarket/commit/84b7f17)
- See `DEVLOG.md` under "Architecture"; `BUGS.md` row 2026-09-23
  (Backend).

## 2026-09-20 — Fix orphaned Linux server process on non-graceful close

Reported by a real Linux tester: closing the launcher without first
clicking Stop (taskbar/dock "Quit", session logout, `kill`, Ctrl+C in a
launching terminal) left the supervised Node server running as an
orphan, still bound to the port - the next launch (including right after
an auto-update) then failed to start it. Those close paths deliver
SIGTERM/SIGINT directly to the process, bypassing the windowing system's
close protocol the existing `CloseRequested` cleanup relies on.

Fixed with a `tokio::signal::unix` handler (SIGTERM + SIGINT,
`#[cfg(unix)]`-gated) that kills the supervised child before the
launcher exits, same as the existing window-close cleanup. Deliberately
avoids `PR_SET_PDEATHSIG` (the more bulletproof alternative) - its
thread-tracking semantics are a real footgun on a multi-threaded tokio
runtime, risking the server getting killed mid-session for no reason.

- **Needs a launcher rebuild to reach users.**
- Windows re-verified with `cargo check` (new code is fully
  `#[cfg(unix)]`-gated, compiled out there). **Unix branch not compiled
  or run** - no Linux Rust target on this machine. Needs a real Linux
  smoke test (send SIGTERM to a running launcher, confirm the server
  process is gone) before/soon after this ships.
- See `DEVLOG.md` under "Desktop launcher"; `BUGS.md` row 2026-09-20
  (Launcher, Linux).
