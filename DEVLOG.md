# OpenMarket — Technical Devlog

The detailed version of [README.md](README.md): architecture rationale,
every confirmed SpaceNinjaServer/warframe.market API mechanism (with
evidence, not guesses), and a dated history of what's been built, broken,
and fixed. Read this if you're extending the code, debugging something,
or just want to know *why* it works the way it does. For a fast-scan
table of specific bugs (fixed and still-open) instead of narrative
prose, see [BUGS.md](BUGS.md).

## Scope, in detail

**Mods/Arcanes** route through SpaceNinjaServer's `addMods()`/
`RawUpgrades` mechanism server-side (category `Upgrades`), with an
optional rank (buy-only).

**Relics** are plain `MiscItems`-category stackable grants at any
refinement (Intact/Exceptional/Flawless/Radiant, buy AND sell) —
warframe.market's `gameRef` for a relic is the base path with no
refinement suffix, so this app resolves the right suffix server-side per
order.

**Prime parts (Warframe and weapon)** are category `Recipes`. For a
**Warframe**, all 4 real tradeable members of a set (the main Blueprint +
the 3 component Blueprints) are `ExportRecipes`-backed. The finished
components a main Blueprint's ingredients list (e.g.
`...SystemsComponent`) are *not* what's actually tradeable — a separate
`...SystemsBlueprint` recipe builds them, and that's the real tradeable
item. A Set's own `gameRef` (e.g. `/Lotus/Powersuits/Volt/VoltPrime`) is
the *finished Warframe's own type path* and is never granted directly —
that would route through `addPowerSuit()` (unique-instance, deliberately
avoided, same class of problem as unique-instance gear). "Buying a set"
instead grants every member part individually in one script-side loop,
for one bundled price sourced from the Set's own real warframe.market
listing.

**Weapon** Prime parts (added 2026-09-20) follow the same "grant every
real part" model, but not the fixed 4-part shape — a weapon's physical
components (Barrel/Receiver/Blade/Handle/etc.) are directly tradeable
Recipes already, no two-stage resolution needed, but part count runs 2-4
depending on weapon type (confirmed from source across all 87 real Prime
weapon blueprints in `ExportRecipes.json`, not assumed to generalize from
the Warframe 4-slot model — see `server/tools/generate-prime-weapon-sets.js`'s
header comment for the full breakdown). A handful of Akimbo pistols also
need 2 copies of the same real part (e.g. 2x Barrel + 2x Receiver), or
even a nested copy of an entirely different, already-existing single
Prime's own part set — Akmagnus/Aklex/Akbronco/Akvasto Prime are each
built from 2 complete copies of a single pistol's own 3-part set (that
single pistol's finished weapon isn't itself tradeable, only its
Blueprint/Barrel/Receiver are) plus their own Link part. The generator
resolves this recursively so `parts` always lists real, individually
grantable gameRefs, duplicates included; `itemsCache.ts`'s
`buildPrimeCategoryItems()` dedupes those duplicates for the flat
per-part catalog rows and the parts-accordion UI, while the actual grant
list (used at buy time) keeps every duplicate, since e.g. Akmagnus Prime
genuinely needs 2 Magnus Prime Blueprints granted, not 1.

## Architecture

```
Browser  <-->  server/ (Node/Express/TypeScript)  <-->  warframe.market's public v2 API (read-only)
                    ^  |
                    |  v  (poll / report, plain HTTP, no auth)
          scripts/Market Sync.pluto  <-->  SpaceNinjaServer (via owf_get_auth_query())
```

The backend never talks to SpaceNinjaServer — it has no game session. Only
the running Pluto script does, so only it is allowed to touch
SpaceNinjaServer. The two communicate over a tiny internal HTTP queue:

- `GET /internal/pending-order` — the script polls this every ~2s.
- `POST /internal/order-result` — the script reports what happened.

Both are meant for the script only, not the browser — there's no auth on
them because everything here is meant to run on localhost for one account.
**Don't expose this backend beyond localhost.**

**`GET /api/status`** (added 2026-09-18) is public, documented API — safe
to `curl` directly, not just for the launcher. It reports server uptime,
the price database's state (`empty`/`seeded`/`live`, mirroring whether a
real 90-day sweep has completed this run vs. still running on the bundled
seed), and whether `Market Sync.pluto` has polled `/internal/pending-order`
recently (`pluto.connected` — a last-poll timestamp under an 8s staleness
window, 4x the script's own 2s poll interval, to absorb normal jitter
without flapping). It's the only signal this server has of the script's
presence, since the script always initiates contact. Carries a
`schemaVersion` field specifically so a consumer can detect a shape it
doesn't understand and show "unknown" rather than misreading a renamed/
restructured field as a false status.

**Why Node/Express/TypeScript**: SpaceNinjaServer's own backend is
Node/Express/TypeScript. Keeping this in the same stack means the
mapping/pricing/order logic here could realistically be adapted into a
page inside SpaceNinjaServer's own WebUI by someone who wanted that,
rather than needing a rewrite.

**`express.json()` body size limit (fixed 2026-09-23)**: mounted with no
explicit `limit`, so it silently fell back to Express's built-in 100kb
cap. `POST /internal/inventory-snapshot` — the full inventory dump
`Market Sync.pluto` reports every poll cycle — grew past that once Mods,
Arcanes, Relics, and Prime Warframe/Weapon parts and sets were all added
to what gets tracked, and started failing with
`PayloadTooLargeError: request entity too large` before reaching any
route handler. Set to `10mb`, verified with a scratch-port curl (200KB
test body: `413` before, `400` route-level validation after — i.e. it
now actually reaches the handler).

## Pricing

Prices are **90-day historical medians**, not live order-book snapshots.
A background sweep over the whole catalog fetches each item's daily
median price for the last 90 days (warframe.market computes each day's
number itself, from real closed trades — this app just takes the median
*of* those ~30-90 daily numbers) and stores one platinum figure per item
per rank/refinement, persisted to `server/price-history.json`. Serving a
price is then a plain in-memory lookup with **zero network calls at
request time** — every price on a page, and even sorting the entire
catalog by price, resolves in milliseconds. The whole sweep re-runs
**weekly**; a 90-day rolling window barely shifts day to day, so this
stays current without needing to be more frequent.

This is the **legacy v1 API** — v2 (used for everything else in this
app) has no equivalent endpoint at all (checked directly: none of
`/v2/item/:slug/statistics`, `/v2/items/:slug/statistics`, or
`/v2/statistics/:slug` exist). It's the only source of real historical
price data available at all, but unlike v2 it's not guaranteed to keep
being maintained — if warframe.market ever removes it, prices would
gradually go stale/missing over the following weeks rather than breaking
outright, since a failed sweep just leaves the previous week's data in
place.

**Rate limiting, measured not assumed**: firing 5 concurrent requests
against this endpoint triggered near-immediate `429`s; a fully
*sequential* sweep (one request in flight at a time, ~150ms apart) did
not, across 2558 real items with zero failures. This looks like a
concurrent-connections limit rather than a requests-per-second one — the
fix was going sequential, not slower. A full sweep takes roughly 6-8
minutes; the first one (nothing cached yet) runs automatically on
startup in the background without blocking the app, so browsing works
immediately, just without prices for anything the sweep hasn't reached
yet.

**Backfill for newly-added items, added 2026-09-20.** The weekly sweep is
purely time-gated (`lastRefreshCompletedAt` + 7 days) — a catalog change
between sweeps (new Prime parts/sets added to this app, or DE shipping
new tradeable items) previously meant a brand-new slug had literally no
price entry until the next natural weekly boundary, up to a week away,
since a real non-stale sweep already in place meant the timer wouldn't
re-fire early. Reported the same day the 87 weapon Prime sets were added.
Fixed with a separate `runBackfillSweep()`, run alongside the existing
hourly staleness check: it diffs the current catalog's slugs against
what's already in `priceHistory` and sweeps ONLY the missing ones, at the
same rate-limit-safe sequential pace as a full sweep (never runs
concurrently with one - shares `refreshInProgress`). Deliberately does
NOT advance `lastRefreshCompletedAt`, since that field gates the full
sweep specifically (which also refreshes existing slugs' potentially
stale prices) and a backfill run must never delay that. Verified live:
restarting with 377 newly-classified weapon Prime slugs missing triggered
an automatic backfill that filled all 377 in the background without
touching the full-sweep timer.

**Manual "Update Prices" button, same day.** `POST /api/refresh-prices`
(`triggerManualRefresh()`) starts a full resweep on demand for a user who
wants genuinely current numbers everywhere right now, not just gap-filled
new items - returns `202 {started: true}` immediately (the sweep itself
still takes several minutes and runs in the background, same as the
automatic one) or `409` if one's already running. The frontend polls the
existing `GET /api/status` `database.refreshInProgress` field rather than
needing a new status endpoint - the button shows "Updating Prices…"
(disabled) for the duration, including on page load if a sweep was
already in progress from another trigger. Verified via curl (409 while a
sweep was running, 202 once it finished) and in a real browser
(Playwright): button state correctly reflected an in-progress sweep on
load, and Boltor Prime Set/parts and Akmagnus Prime Set (the
duplicate-parts case) all showed real resolved prices once their backfill
completed.

If a specific rank or refinement has no trade history in the last 90 days
at all, **ladder interpolation** linearly interpolates between whichever
other rungs of the same item do have history, or clamps to the nearest
single known rung rather than extrapolating past it. This applies to both
mod/arcane rank (0..max) and relic refinement (Intact/Exceptional/
Flawless/Radiant, treated as an ordered 0-3 ladder even though the steps
are named instead of numbered) — neither assumes its first/last rung
specifically has data, which is what keeps it from breaking for an item
whose max rank or Radiant refinement has simply never traded. Relics were
the only item type with no such fallback until this was fixed 2026-09-18
(reported as "Relic prices sometimes show 'no price' instead of falling
back like Mods do") — both ladders now share one interpolation function.

**Bundled fallback dataset.** `server/price-history.seed.json` is a real,
verified snapshot committed to the repo (unlike `price-history.json`,
which is gitignored runtime output) — on a fresh clone/install with no
local cache yet, it's loaded immediately so prices are available from the
first page load instead of nothing for the ~6-8 minutes the first live
sweep takes, while that live sweep still kicks off in the background to
refresh/replace it. It's also the rollback dataset if the legacy v1
endpoint this whole feature depends on is ever removed outright — a
known-good snapshot to fall back to rather than the shop going priceless.

A **"?"** anywhere (price, a ranked-copy dropdown line's price, or
"Owned: ?") is clickable to retry just that one value instead of waiting
for the next full re-render.

## Frontend

The header logo and favicon are both real Warframe platinum currency
icon assets pulled from `warframe.market`/`wiki.warframe.com` — the logo
source image isn't square (711x505), so it's cropped to a clean 1:1 icon
via `object-fit: cover` on a fixed-size box rather than stretched.

Real pagination (40 items/page — 2000+ items exist across all four
categories), a type filter (All/Mods/Arcanes/Relics/Primes), and a
List/Grid view toggle. Grid view is pure CSS on the same row markup as
List — toggling between them never re-fetches prices.

Mods/Arcanes get a rank stepper (shown as e.g. "3 of 10") that live-updates
the displayed price from warframe.market's per-rank order data — buying
grants the exact rank shown. The main row's own **Sell always targets
rank-0 stock only**, auto-disabling whenever a nonzero rank is selected on
the stepper — the owned-ranks breakdown (below) is for selling a specific
ranked copy you already own.

Owning multiple ranks of the same mod/arcane at once (e.g. a rank 0, rank
3, and max-rank Serration) would otherwise be invisible — the plain
"Owned: N" count only ever reflects the rank-0 stack. A **"▸ N owned at
other ranks"** toggle appears whenever you own any ranked copies, expanding
to one line per rank ("Rank 3 — Owned: 1") each with its own Sell button
that removes exactly that one instance — resolved server-side to a real
database id, not a guess (see [Confirmed HTTP mechanics](#confirmed-http-mechanics)).

Relics get the same +/- stepper, reused for a different purpose: cycling
through Intact/Exceptional/Flawless/Radiant. Unlike rank, refinement isn't
a unique-instance thing server-side (just a different plain grantable
path per option), so **both Buy and Sell work at any refinement** — Sell
never disables for relics.

Prime parts/sets get no stepper (no rank/refinement concept) — individual
parts behave exactly like a Relic row (Buy + Sell). A Set row instead
shows a single **"Buy Full Set"** button in place of Buy/Sell, plus a
**"▸ Parts"** dropdown toggle in the Sell button's slot that expands to
show its real member parts (2-4, depending on Warframe vs. weapon and
weapon type) as nested rows (each with normal Buy/Sell), collapsed by
default and deduped by gameRef first — a weapon set's `parts` can
legitimately list the same real part more than once (see
[Scope, in detail](#scope-in-detail)). Browsing/searching Primes shows one
row per set instead of one-per-part — a part only stays a standalone
top-level row if its owning set isn't also in the current filtered
results (e.g. searching "chassis blueprint" matches every frame's Chassis
part by name but no set name contains "chassis", so there's nothing to
nest under).

Individual Prime part rows also get a small badge in the icon's
bottom-right corner showing which slot it is — hand-drawn glyphs, not
real game assets (those slot icons are packed game textures, not exposed
in the local Public Export data), derived from the part's own gameRef
suffix. Warframe parts are one of exactly 4 fixed slots
(Blueprint/Neuroptics/Chassis/Systems), verified uniform across all 50
sets. Weapon parts vary by weapon type (Barrel/Receiver/Stock/Blade/
Handle/Link/etc., ~17 possible names confirmed from source) — the 6 most
common get their own icon, the rarer ones share one generic glyph (exact
name still shown in the tooltip).

Every sellable row also shows an **"Owned: N"** count (red at 0), reported
live by `Market Sync.pluto` from `/api/inventory.php`. Sell auto-disables
once the confirmed count is 0; before any inventory sync has landed yet it
shows "Owned: ?" and never blocks Sell (an unknown count is never treated
as "definitely zero"). This is a UX aid only, not a safety mechanism —
SpaceNinjaServer's own `sellController.ts` already refuses to oversell
server-side regardless of what this app thinks you own. Prime sets skip
the display entirely.

### Sorting and filtering

A **Sort** dropdown covers Name (A-Z/Z-A), Type, Owned quantity
(High-Low/Low-High), and Price (Low-High/High-Low). Name and Type sort
purely off data already in hand — instant. **Owned** sort needs one extra
request the first time it's used (a single bulk lookup, `GET /api/owned-summary`,
no external calls), then it's cached for the session. **Price** sort
fetches a price for every item in the current filtered view first, but
since prices are a pre-computed in-memory lookup with no live network
call behind them, even sorting the entire unfiltered catalog resolves in
under a couple seconds. Items with no known price always sort last.

An **Owned / Not Owned** filter uses the same bulk lookup — "Owned" means
owning *any* variant of the item at all (summed across ranks/refinements),
not tied to whatever's selected on the stepper.

**Rarity** (Common/Uncommon/Rare/Primed) shows only on the Mods tab, and
the same filter with a **Legendary** label instead of **Primed** shows
only on the Arcanes tab — same underlying warframe.market rarity tag
either way, labeled per-tab to match what players actually call that
tier. **Relic era** (Lith/Meso/Neo/Axi/Requiem) shows only on the Relics
tab. Switching tabs resets that tab's filter back to "All".

## Probe scripts

Optional one-shot diagnostics in **`scripts/probes/`** (moved out of
`scripts/` itself, 2026-09-19 — a real user copied the whole `scripts/`
folder instead of just `Market Sync.pluto` as instructed, which put
every probe on equal footing in OpenWF's script-runner UI and led to one
getting run by mistake, confusing a real support conversation. Separate
subfolder means copying `scripts/` wholesale no longer sweeps these in),
useful as a **deliberate** sanity check on a new/unfamiliar SpaceNinjaServer
instance — not something a normal install should ever run:

- `Market Sell Probe.pluto` — tests `/api/sell.php` in isolation (grants
  a cheap mod, sells it back, reports pass/fail to chat).
- `Market Ranked Mod Probe.pluto` — tests the rank-buy mechanism
  (`Fingerprint: {"lvl":N}` on the grant).
- `Market Prime Recipe Probe.pluto` — tests the `Recipes` category Prime
  parts use (grants a cheap Blueprint, pauses so you can check the
  Foundry, sells it back).
- `Market Inventory Flake Probe.pluto` — measures `/api/inventory.php`'s
  real reliability on your setup (15 isolated calls, reports success
  rate/timing — see the flakiness writeup under
  [Confirmed HTTP mechanics](#confirmed-http-mechanics)).
- `Market Ranked Sell Probe.pluto` — tests selling a specific ranked copy
  by its real database id.

## Desktop launcher

`launcher/` is a Tauri v2 + React/TypeScript desktop app that supervises
`server/` instead of running `npm start` in a terminal by hand: start/
stop/restart, a live status dashboard (polls `GET /api/status`), a
collapsible terminal panel streaming the server's real stdout/stderr, and
a settings drawer for the repo path/port/Pluto scripts directory.

Runs `node <server>/node_modules/tsx/dist/cli.mjs src/index.ts` directly
rather than `npm start` — on Windows, `npm` is a `.cmd` wrapper that
spawns `node.exe` as a further child process, so killing the wrapper on
Stop can orphan the real server process holding the port. Invoking tsx's
own JS entry point means there's exactly one process, and closing the
launcher (or hitting Stop) actually terminates it.

**Real bug, found via a v1.0.0 user report (2026-09-19): `Command::new("npm")`
fails outright on Windows with `program not found`, not just an
orphan-process risk like the case above.** `install_server_deps`
(the `npm install` step) had been spawning bare `npm` directly — Rust's
`Command` can't execute a `.cmd` batch file the way it executes a real
`.exe`, confirmed by reproducing the exact error in an isolated
`tokio::process::Command::new("npm")` test on this machine. This is a
different failure mode than the orphan-process reasoning above (which is
about *what happens after* a successful spawn) — this one never spawns
at all. Missed originally because this session's own testing of the
install flow went through a **Bash**-invoked `npm install` as a proxy
for the Rust command, and Bash resolves/executes `.cmd` files through a
completely different mechanism than Rust's `Command` does — the proxy
test passed while the real code path was actually broken the whole time.
**Lesson: a shell-invoked equivalent is not proof a Rust `Command::new()`
call will do the same thing on Windows — the batch-file-as-program case
specifically needs testing via an actual Rust process spawn, not a
shell stand-in.**

Fixed by asking the system node for its own `process.execPath` (a real
`.exe`, spawns fine) and invoking npm's own CLI entry point directly
through it (`<node_dir>/node_modules/npm/bin/npm-cli.js`) — same
"invoke the JS entry directly, skip the wrapper" pattern already used
for tsx. Verified with a real `tokio::process::Command` spawn test
reproducing both the original failure and the fix working, not just a
compile check.

**Follow-up bug, found via a Homebrew/Linuxbrew user report (2026-09-20):
this fix was applied unconditionally across all platforms, but the
`.cmd`-can't-spawn problem it solves is Windows-only** — on Unix,
`npm`'s own shim is a real executable (a shebang script the kernel
dispatches directly), so `Command::new("npm")` already worked fine
there and never needed the manual resolver at all. The unconditional
version instead broke Homebrew installs: npm ends up at
`<brew prefix>/lib/node_modules/npm/bin/npm-cli.js`, which has no
fixed relative path to the node binary's own directory (which itself
resolves through a versioned `Cellar/node/<version>/bin/`, not the
prefix-level symlink) — the guessed `<node_dir>/../lib/...` fallback
never matched. Rather than add yet another guessed relative layout
(nvm/volta/fnm/apt all differ too), the manual `npm-cli.js` resolver
is now `#[cfg(target_os = "windows")]`-gated; Unix goes through
`Command::new("npm")` directly and lets `$PATH` resolve it the same
way it already resolves `node`. Windows branch re-verified with a real
`cargo check`; the Unix branch could not be compiled on this (Windows)
machine — no Linux Rust target installed here — so it's verified by
reasoning (same shape as the already-working `check_node`'s
`Command::new("node")`) rather than an actual build.

Has an **Install** step: if `server/`'s dependencies aren't installed
yet, or the configured Pluto scripts folder is missing
`Market Sync.pluto`, the primary button reads "Install" instead of
"Launch App" — runs `npm install` and/or copies the script in (never
overwriting one that's already there, in case it's been customized
in-game), then switches to "Launch App" once everything checks out.

**Node.js is required and not bundled** — the launcher relies on a
system Node 18+ install for both `npm install` and running the server
itself; there's no private/portable Node runtime shipped alongside it
(a real, separate feature, not built - would mean downloading and
extracting Node's own portable archive per-platform, and threading a
private-vs-system node path through both Install and Launch). If Node's
missing or too old, a dedicated banner replaces the normal Install flow
with an "Open nodejs.org" link — deliberately not attempted
automatically, since installing Node mid-session wouldn't even be picked
up (Windows doesn't propagate `PATH` changes to already-running
processes), so the user has to restart the launcher afterward regardless.

The originally-planned multi-step first-run onboarding wizard was
deliberately dropped in favor of inline validation hints (✓/✗ next to
the repo-path and Pluto-scripts-dir fields) — simpler, and covers the
same "did I point this at the right folder" problem without a dedicated
flow.

On Linux, needs the usual Tauri system packages to build from source:
`libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`,
`patchelf`, `build-essential` (Debian/Ubuntu names; see
[Tauri's prerequisites docs](https://tauri.app/start/prerequisites/) for
other distros). Untested on an actual Linux machine as of 2026-09-18 —
this list is Tauri's documented requirement, not independently confirmed
on this project yet.

**Orphaned server process on Linux close, found via a real Linux tester
report (2026-09-20).** Closing the launcher without first clicking Stop
left the supervised Node server running as an orphan, still bound to the
port — the next launch (including right after an auto-update, since the
updater replaces the binary but can't touch an already-running unrelated
process) then failed to start it at all. Root cause: the existing
`on_window_event` `CloseRequested` handler (kills the child before the
window actually closes) only fires for a graceful window close - the X
button, Alt+F4. A taskbar/dock "Quit", a session logout, or a plain
`kill`/Ctrl+C in a launching terminal all deliver SIGTERM or SIGINT
directly to the process instead, bypassing the windowing system's close
protocol entirely - neither Rust nor Tauri installs a handler for those
by default, so the process just dies without running any cleanup at all.
Not a gap Windows shares - its equivalent close paths already funnel
through `WM_CLOSE` into the same `CloseRequested` event.

Fixed with a `tokio::signal::unix` listener (`SIGTERM` + `SIGINT`,
`#[cfg(unix)]`-gated so it's fully compiled out on Windows) that kills
the supervised child before the launcher process itself exits, mirroring
the existing `CloseRequested` cleanup. Deliberately does **not** use
`PR_SET_PDEATHSIG` - the Linux-native "kill my child no matter how I
die" `prctl()` flag, which would also survive an uncatchable `SIGKILL`
that a userspace signal handler can't. Its semantics (per `man 2 prctl`)
track the specific OS *thread* that forked the child, not the process as
a whole - a real footgun on a multi-threaded tokio runtime
(`rt-multi-thread` is in use here): the exact thread that happened to
perform the fork could get recycled by tokio's own thread pool while the
launcher is still very much alive, killing the server out from under a
running session for no visible reason. A plain signal handler has no
such risk and covers every closing path except `SIGKILL` - which isn't a
gap this fix (or any userspace fix, in any language) could close anyway.

Windows re-verified with a real `cargo check` (the new code is entirely
behind `#[cfg(unix)]`, so it doesn't even get compiled there). **The Unix
branch itself is unverified** - no Linux Rust target on this machine, so
it's neither compiled nor run; `tokio::signal` has no known
multi-threading gotchas the way `PR_SET_PDEATHSIG` does, but this
genuinely needs a real Linux smoke test (send `SIGTERM` to a running
launcher, confirm the Node process is actually gone afterward) before or
soon after it ships.

### Releases and auto-update

Tagged releases (`v*`) build via GitHub Actions
(`.github/workflows/release.yml`) for **Windows (two artifacts: an NSIS
installer AND a portable `.zip` of the raw exe) and Linux (AppImage)**.
The portable Windows zip exists because not every user wants an
installer-wizard/Program-Files experience — but it's a real tradeoff,
not a free option: **the portable exe can't self-update.** Tauri's
Windows updater plugin works by re-launching an installer, not by
replacing a standalone binary in place (unlike Linux AppImage, which the
updater CAN self-replace) — confirmed from the plugin's own API docs
(`install()`'s doc comment: "Windows: This function exits the app after
launching the updater installer successfully"). **Untested what actually happens if a portable-zip user clicks "Update &
Restart"** — the updater always points at the same `latest.json` entry
(the NSIS installer artifact) regardless of how the running copy was
obtained, so the realistic guess is it downloads and silently runs that
installer, converting a portable install into a real Program-Files one
rather than failing outright — but that's a guess, not confirmed. The UI
doesn't currently distinguish "am I the portable exe or the installed
copy" at all. Worth an explicit test before calling this solid.

Releases are created as **drafts** — nothing goes public or notifies
watchers until manually published on GitHub. The app checks for updates
once on startup (silently, no error shown if offline/unreachable) and
shows a banner with an "Update & Restart" button if a newer version is
available. Update packages are signed — CI needs
`TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets
configured on the repo, or the release step fails.

## Confirmed HTTP mechanics

Read directly from SpaceNinjaServer's source, not guessed:

- **Buy**: `POST /custom/addItems` `[{ItemType, ItemCount: 1}]`, then
  `POST /custom/addCurrency` `{currency:"PremiumCredits", delta: -price}`.
- **Sell**: `POST /api/sell.php` `{SellCurrency:"SC_RegularCredits",
  SellPrice:0, Items:{<category>:[{String:<ItemType path>, Count:1}]}}`,
  then `POST /custom/addCurrency` with a positive delta. `<category>` is
  `Upgrades` for mods/arcanes or `MiscItems` for relics — the backend
  tags each item with its category so `Market Sync.pluto` doesn't have to
  guess. This is the **real Warframe client's own** sell-to-market
  endpoint (not a SpaceNinjaServer-specific admin route) —
  SpaceNinjaServer's own WebUI "bin icon" delete button calls it the same
  way with `SellPrice: 0`. For both categories, an entry with a `String`
  that's an `ItemType` path (not a bare database id) and `Count > 0`
  decrements that many stacked copies **by path** — no need to look up a
  specific owned copy's id first, unlike unique-instance gear.
- **Content-Type gotcha**: `/api/sell.php` needs `Content-Type:
  text/plain`, not `application/json` (unlike every other SpaceNinjaServer
  call here) — its controller does `JSON.parse(String(req.body))`, which
  expects the raw string body. Sending JSON content-type lets Express
  pre-parse the body first, breaking that call with an opaque empty
  `HTTP 500`. See `scripts/probes/Market Sell Probe.pluto`'s header comment for
  the full writeup.
- `gameRef` on a warframe.market v2 item entry (e.g.
  `/v2/item/serration` → `gameRef: "/Lotus/Upgrades/Mods/Rifle/
  WeaponDamageAmountMod"`) is directly the real client `ItemType` path —
  no separate mapping table is needed to go from a market item to what to
  grant/remove. For relics specifically, `gameRef` is the BASE path with
  no refinement suffix — resolved to the right suffix server-side per
  order.
- **CONFIRMED WORKING end-to-end for all categories (2026-09-17)** — Mods,
  Arcanes, and Relics each verified with a real in-game buy + sell round
  trip through this UI against a live SpaceNinjaServer instance.
- **Rank (mod/arcane fusion level), CONFIRMED WORKING (2026-09-17).**
  Buying at rank > 0 sends `Fingerprint: JSON.stringify({lvl: N})` on the
  grant — the same mechanism SpaceNinjaServer's own WebUI uses for its
  "acquire mod max" flow. Verified live: a rank-3 Serration appeared in
  the Mods screen after granting it through this mechanism.
- `/api/inventory.php` (used by the ranked-mod probe, and by
  `Market Sync.pluto`'s owned-count sync) intermittently fails with
  `Connection Closed Prematurely` — measured at a real, bounded **~25-30%
  per-call failure rate** on one setup via `Market Inventory Flake
  Probe.pluto` (15 isolated calls, 4s apart: 11/15 succeeded, longest
  failure streak was 1). Response size was IDENTICAL on every success —
  exactly 305141 bytes, zero variance — and timing was fast and
  consistent on both success AND failure (55-68ms), which rules out
  payload size or a slow timeout as the cause. Root cause otherwise
  unconfirmed (no timeout knob is available on Pluto's `http.request` to
  tune). Not fixable from script-side, but bounded and well-behaved
  enough that a short retry loop lands a successful sync within a few
  seconds the large majority of the time.
- **Retry cadence fix, 2026-09-17.** The owned-count feature originally
  waited the full `INVENTORY_POLL_MS` (30s) after every failed attempt
  before retrying — at the measured flake rate, a bad-luck streak could
  leave "Owned: ?" stuck for minutes. Split into two intervals:
  `INVENTORY_POLL_MS` (30s) applies only after a **success**,
  `INVENTORY_RETRY_MS` (5s) applies after a **failure**.
- **Relic refinement, CONFIRMED WORKING (2026-09-17).** `routes.ts`
  resolves `base + {Bronze,Silver,Gold,Platinum}` server-side per order,
  so `Market Sync.pluto` needed **zero changes** — it just sees an
  already-resolved `gameRef`, same as every other order.
- **Prime Warframe parts/sets (category `Recipes`), CONFIRMED WORKING
  (2026-09-17).** Structurally identical to the already-proven
  `Upgrades`/`MiscItems` categories. Confirmed with
  `Market Prime Recipe Probe.pluto`: granted a Prime Blueprint, visually
  confirmed it appeared in the Foundry's Blueprints tab, sold it back,
  visually confirmed it was gone. "Buy Full Set" was also verified
  through the real UI.
- **Prime WEAPON parts/sets (added 2026-09-20) reuse this identical
  mechanism** — same category `Recipes`, same plain path+count grant/sell
  call, just different (weapon) gameRefs — so no new in-game mechanism
  confirmation is needed beyond the Warframe Prime Recipe probe above.
  What's genuinely new and NOT yet in-game-verified is the *data* itself:
  whether every one of the 87 generated `parts` lists (especially the 4
  Akimbo sets with a nested/duplicated inner set - see
  [Scope, in detail](#scope-in-detail)) is actually correct end-to-end
  for a real Foundry build. Verified so far only against source
  (`ExportRecipes.json`) and a scratch-port curl pass confirming the app
  resolves/enqueues them without error (order creation for both a plain
  weapon part and the 8-part Akmagnus Prime Set succeeded, `/api/items`
  correctly resolved 85 of the 87 candidate weapon sets against the live
  warframe.market bulk list), not against a real in-game grant.
- **Owned-count sync (`GET /api/owned`, `POST /internal/inventory-snapshot`),
  CONFIRMED WORKING (2026-09-17).** `Market Sync.pluto` fetches
  `GET /api/inventory.php` on its own 30s timer and reports a flattened
  `{ItemType: count}` map built from the response's `RawUpgrades`/
  `MiscItems`/`Recipes` arrays — field names/shapes confirmed from
  SpaceNinjaServer's actual `inventoryTypes.ts`. **Not a safety-critical
  mechanism** — SpaceNinjaServer's own `sellController.ts` throws if a
  sell would take a stored count negative, so a stale/wrong/missing
  snapshot can at worst let a doomed Sell click through to a normal
  failed-order toast, never an actual oversell.
- **Ranked-copy breakdown + sell-by-oid, CONFIRMED WORKING (2026-09-17).**
  A ranked grant's `Fingerprint` field is stored server-side as
  `UpgradeFingerprint` on that copy's `Upgrades` collection entry
  alongside its real database id (`ItemId`). Selling one specific
  instance by that id takes a completely different `sell.php` code path:
  a `String` with no `/` in it is treated as a bare database id and
  deleted directly (`inventory.Upgrades.pull({_id: String})`). Verified
  live with `Market Ranked Sell Probe.pluto`.

## Known limitations

- **The launcher's Pluto-connected status is a heuristic, not a real
  connection check.** `Market Sync.pluto` always initiates contact; the
  server has no way to reach out to it. "Connected" just means a poll was
  seen recently (within 8s) — a script that's running but stuck/erroring
  after its initial poll could still show "Connected" for up to 8s after
  it actually stopped doing anything useful. Check the terminal panel /
  the Bootstrapper's `script_log` for actual script health.
- **No launcher release published yet** — has to be built from source
  until the first tag is pushed.
- **Linux support is source-verified, not build-verified** as of
  2026-09-18 — no one has actually run a build on a real Linux machine
  yet; the first tagged release will be the first real test.
- **"Peculiar" mods were miscategorized as Arcanes until fixed 2026-09-18.**
  The 4 Peculiar mods (Growth/Bloom/Audience/End) carry BOTH `"mod"` and
  `"arcane_enhancement"` tags simultaneously on warframe.market — the only
  items with that overlap. Classification checked `arcane_enhancement`
  first, so these landed under Arcanes; reordered so `mod` wins.
- **Rivens are deliberately excluded entirely.** A filter bug (checking
  for the exact tag `"riven"` instead of any tag containing `"riven"`)
  let 7 "Veiled Riven Mod" placeholders slip through until fixed
  2026-09-17 — selling one from the shop would have decremented the same
  stackable ItemType a player's real earned-in-game veiled Rivens live in,
  indistinguishably. Fixed.
- No unique-instance gear yet (weapon/Warframe skins turned out not to be
  tradeable on warframe.market at all — Syndicate armor pieces are the
  concrete remaining candidate if this is ever picked up; would need
  `/api/inventory.php`-based oid resolution).
- Selling a specific ranked mod/arcane copy is only possible through the
  "▸ N owned at other ranks" breakdown, not the main row's Sell button.
- Weapon Prime parts/sets are unverified in-game (see
  [Confirmed HTTP mechanics](#confirmed-http-mechanics) above) — data
  correctness only, not a new mechanism. 2 of the 87 candidate blueprints
  in Public Export (Galariak/Sagek Prime) don't resolve against a real
  warframe.market listing and are silently skipped, same as any
  unresolvable Warframe set.
- Selling a full Prime set isn't supported, only individual parts — a
  deliberate scope choice (matches how a player would realistically use
  this anyway).
- No persistence — a backend restart drops any in-flight order.
- Owned counts can lag reality by up to 30s after a change made outside
  this shop. Buy/sell orders placed through this shop itself update the
  displayed count instantly (optimistic local adjustment).
