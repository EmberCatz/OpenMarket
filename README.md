# OpenMarket — an OpenWF Market Emulator

A local, personal **shop** for [OpenWF](https://onlyg.it/OpenWF)-based
Warframe private servers, priced off real
[warframe.market](https://warframe.market) order data. It is **not** real
trading — there is no other player on the other end. Buying and selling
self-grants items and platinum through
[SpaceNinjaServer](https://github.com/spaceninjaserver/SpaceNinjaServer)'s
own HTTP API. Framed honestly: this is "warframe.market-priced self-service
shop," not a peer-to-peer market emulator.

Not affiliated with Digital Extremes, Warframe, warframe.market, OpenWF, or
SpaceNinjaServer. Requires an OpenWF Bootstrapper client and a
SpaceNinjaServer instance you already control — it does not work against
the real Warframe servers.

**Scope: Mods + Arcanes + Relics (any refinement) + Prime Warframe parts
& sets.** Mods/Arcanes route through SpaceNinjaServer's identical
`addMods()`/`RawUpgrades` mechanism server-side (category `Upgrades`),
with an optional rank (buy-only). Relics are plain `MiscItems`-category
stackable grants at any refinement (Intact/Exceptional/Flawless/Radiant,
buy AND sell) — warframe.market's `gameRef` for a relic is the base path
with no refinement suffix, so this app resolves the right suffix
server-side per order. See [Known limitations](#known-limitations) for
what's not covered yet.

**Prime Warframe parts** are category `Recipes` — all 4 real tradeable
members of a set (the main Blueprint + the 3 component Blueprints) are
`ExportRecipes`-backed. The finished components a main Blueprint's
ingredients list (e.g. `...SystemsComponent`) are *not* what's actually
tradeable — a separate `...SystemsBlueprint` recipe builds them, and
that's the real tradeable item. A Set's own `gameRef` (e.g.
`/Lotus/Powersuits/Volt/VoltPrime`) is the *finished Warframe's own type
path* and is never granted directly — that would route through
`addPowerSuit()` (unique-instance, deliberately avoided, same class of
problem as unique-instance gear below). "Buying a set" instead grants
every member part individually in one script-side loop, for one bundled
price sourced from the Set's own real warframe.market listing. v1 covers
Warframes only (fixed 4-part shape); weapons vary 2-5 parts and are
deferred.

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
to `curl` directly, not just for the launcher below. It reports server
uptime, the price database's state (`empty`/`seeded`/`live`, mirroring
whether a real 90-day sweep has completed this run vs. still running on
the bundled seed), and whether `Market Sync.pluto` has polled
`/internal/pending-order` recently (`pluto.connected` — a last-poll
timestamp under an 8s staleness window, 4x the script's own 2s poll
interval, to absorb normal jitter without flapping). It's the only signal
this server has of the script's presence, since the script always
initiates contact. Carries a `schemaVersion` field specifically so a
consumer can detect a shape it doesn't understand and show "unknown"
rather than misreading a renamed/restructured field as a false status.

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
for the next full re-render — now a much rarer thing to see for price
specifically, since there's no live network call left to fail.

## Why Node/Express/TypeScript

SpaceNinjaServer's own backend is Node/Express/TypeScript. Keeping this in
the same stack means the mapping/pricing/order logic here could realistically
be adapted into a page inside SpaceNinjaServer's own WebUI by someone who
wanted that, rather than needing a rewrite.

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
the stepper — but see the owned-ranks breakdown below for selling a
specific ranked copy you already own.

Owning multiple ranks of the same mod/arcane at once (e.g. a rank 0, rank
3, and max-rank Serration) would otherwise be invisible — the plain
"Owned: N" count only ever reflects the rank-0 stack. A **"▸ N owned at
other ranks"** toggle appears whenever you own any ranked copies, expanding
to one line per rank ("Rank 3 — Owned: 1") each with its own Sell button
that removes exactly that one instance — resolved server-side to a real
database id, not a guess (see Confirmed HTTP mechanics below).

Relics get the same +/- stepper, reused for a different purpose: cycling
through Intact/Exceptional/Flawless/Radiant. Unlike rank, refinement isn't
a unique-instance thing server-side (just a different plain grantable
path per option), so **both Buy and Sell work at any refinement** — Sell
never disables for relics.

Prime parts/sets get no stepper (no rank/refinement concept) — individual
parts behave exactly like a Relic row (Buy + Sell). A Set row instead
shows a single **"Buy Full Set"** button in place of Buy/Sell (selling a
whole set isn't supported — see Known limitations), plus a **"▸ Parts"**
dropdown toggle in the Sell button's slot that expands to show its 4 real
member parts as nested rows (each with normal Buy/Sell), collapsed by
default. Browsing/searching Primes shows one row per set instead of 5 —
a part only stays a standalone top-level row if its owning set isn't
also in the current filtered results (e.g. searching "chassis blueprint"
matches every frame's Chassis part by name but no set name contains
"chassis", so there's nothing to nest under).

Individual Prime part rows also get a small badge in the icon's
bottom-right corner showing which of the 4 fixed Warframe slots it is
(Blueprint/Neuroptics/Chassis/Systems) — hand-drawn glyphs, not real game
assets (those slot icons are packed game textures, not exposed in the
local Public Export data), derived from the part's own gameRef suffix
(`...HelmetBlueprint`/`...ChassisBlueprint`/`...SystemsBlueprint`/plain
`...Blueprint`), which was verified uniform across all 50 sets. Item
icons are 64px in List view / 96px in Grid view.

Every sellable row also shows an **"Owned: N"** count (red at 0), reported
live by `Market Sync.pluto` from `/api/inventory.php` — see Confirmed HTTP
mechanics below for the full mechanism and its measured flakiness. Sell
auto-disables once the confirmed count is 0; before any inventory sync has
landed yet it shows "Owned: ?" and never blocks Sell (an unknown count is
never treated as "definitely zero"). This is a UX aid only, not a safety
mechanism — SpaceNinjaServer's own `sellController.ts` already refuses to
oversell server-side regardless of what this app thinks you own. Prime
sets skip the display entirely (no single owned count means anything for
a 4-part bundle; their Sell slot is already the parts-dropdown toggle).

Hovering an item's icon shows a larger preview next to the cursor — handy
for actually reading a mod's artwork/description at a size the small row
icon can't.

### Sorting and filtering

A **Sort** dropdown covers Name (A-Z/Z-A), Type, Owned quantity
(High-Low/Low-High), and Price (Low-High/High-Low). Name and Type sort
purely off data already in hand — instant. **Owned** sort needs one
extra request the first time it's used (a single bulk lookup over
already-in-memory inventory data, no external calls — see
`GET /api/owned-summary` below), then it's cached for the rest of the
session. **Price** sort still fetches a price for every item in the
current filtered view before sorting (through the same concurrency-
limited queue as everything else) rather than assuming the frontend
already has them all — but since prices are now a pre-computed in-memory
lookup with no live network call behind them (see Pricing below), even
sorting the *entire* unfiltered catalog by price resolves in under a
couple seconds, not the real, visible cost this used to be. Items with
no known price always sort last, in either direction.

An **Owned / Not Owned** filter (next to Sort) uses the same bulk lookup.
"Owned" here means owning *any* variant of the item at all — any rank for
a mod/arcane (rank-0 stack plus every ranked copy, summed), any
refinement for a relic (all 4 summed) — not tied to whatever rank/
refinement happens to be selected on the stepper.

**Rarity** (Common/Uncommon/Rare/Primed) shows only on the Mods tab,
and the same filter with a **Legendary** label instead of **Primed**
shows only on the Arcanes tab — same underlying warframe.market rarity
tag either way; "Primed" mods (e.g. Primed Continuity) share the exact
same top tier Legendary Arcanes use, warframe.market doesn't have a
separate tag for them, so the label is chosen per-tab to match what
players actually call that tier. **Relic era** (Lith/Meso/Neo/Axi/
Requiem) shows only on the Relics tab. Both read tags already present in
warframe.market's bulk item list — no extra lookups. Switching away from
a tab resets its filter back to "All" rather than leaving it invisibly
still applied.

## Setup

1. **Backend**
   ```
   cd server
   npm install
   npm start
   ```
   Listens on `http://127.0.0.1:7890/` by default (override with the
   `MARKET_EMULATOR_PORT` env var). Or use the [desktop launcher](#desktop-launcher)
   instead of a terminal for this step.

2. **Script** — copy `scripts/Market Sync.pluto` into your OpenWF
   `Scripts/` folder and start it in-game (or autostart it). It polls the
   backend and executes queued orders against SpaceNinjaServer. It does
   nothing harmful if the backend isn't reachable — just a failed request
   every couple seconds.

3. **Open the shop** — `http://127.0.0.1:7890/` in a browser while the
   game is running. Search a mod, hit Buy or Sell.

The backend writes `server/price-history.json` after each weekly sweep
(see [Pricing](#pricing)) - gitignored, safe to delete any time to force
a fresh sweep of the whole catalog on next startup, though normally
there's no reason to.

Optional: `scripts/Market Sell Probe.pluto` is a one-shot diagnostic that
tests the trickiest call (`/api/sell.php`) in isolation — grants a cheap
mod, tries to sell it back, reports pass/fail to chat. Useful as a first
sanity check on a new/unfamiliar SpaceNinjaServer instance.

`scripts/Market Ranked Mod Probe.pluto` does the same for the rank-buy
mechanism (`Fingerprint: {"lvl":N}` on the grant) — confirmed working.

`scripts/Market Prime Recipe Probe.pluto` does the same for the `Recipes`
category Prime parts use — grants a cheap Prime Blueprint, pauses 15s so
you can check your Foundry's Blueprints tab, then sells it back and pauses
again — confirmed working.

`scripts/Market Inventory Flake Probe.pluto` measures `/api/inventory.php`'s
real reliability on your own setup — 15 isolated calls, 4s apart, reports
a success rate + response size + timing summary. Useful if the shop's
"Owned: N" counts seem slow to show up; see Confirmed HTTP mechanics below
for what a real run looked like.

`scripts/Market Ranked Sell Probe.pluto` does the same for selling a
specific ranked copy by its real database id — grants a rank-3 Serration,
pauses so you can look, finds its exact id, pauses again, sells it, then
confirms the count dropped by exactly one — confirmed working.

## Desktop launcher

`launcher/` is a Tauri v2 + React/TypeScript desktop app that supervises
`server/` instead of running `npm start` in a terminal by hand: start/
stop/restart, a live status dashboard (polls `GET /api/status` above), a
collapsible terminal panel streaming the server's real stdout/stderr, and
a settings drawer for the repo path/port/Pluto scripts directory.

Runs `node <server>/node_modules/tsx/dist/cli.mjs src/index.ts` directly
rather than `npm start` — on Windows, `npm` is a `.cmd` wrapper that
spawns `node.exe` as a further child process, so killing the wrapper on
Stop can orphan the real server process holding the port. Invoking tsx's
own JS entry point means there's exactly one process, and closing the
launcher (or hitting Stop) actually terminates it.

Also has an **Install** step: if the repo path's `server/` dependencies
aren't installed yet, or the configured Pluto scripts folder is missing
`Market Sync.pluto`, the primary button reads "Install" instead of
"Launch App" — it runs `npm install` and/or copies the script in (never
overwriting one that's already there, in case it's been customized
in-game), then switches to "Launch App" automatically once everything
checks out.

Backend supervision, status polling, the settings drawer, and Install are
confirmed working in dev mode; the originally-planned multi-step
first-run onboarding wizard was deliberately dropped in favor of inline
validation hints (✓/✗ next to the repo-path and Pluto-scripts-dir fields)
— simpler, and covers the same "did I point this at the right folder"
problem without a dedicated flow.

### Building from source

```
cd launcher
npm install
npm run tauri dev      # dev mode, opens a window immediately
# or:
npm run tauri build    # produces a release installer under src-tauri/target/release/bundle/
```

Requires Rust (`rustup`) in addition to Node — only for building; a
downloaded release binary needs neither. On Linux, also needs the usual
Tauri system packages: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`,
`librsvg2-dev`, `patchelf`, `build-essential` (Debian/Ubuntu package
names; see [Tauri's own prerequisites
docs](https://tauri.app/start/prerequisites/) for other distros).
Untested on an actual Linux machine as of 2026-09-18 — this list is
Tauri's documented requirement, not independently confirmed on this
project yet.

### Releases and auto-update

Tagged releases (`v*`) build via GitHub Actions
(`.github/workflows/release.yml`) for Windows (NSIS installer) and Linux
(AppImage specifically, not `.deb`/`.rpm` — AppImage is what Tauri's
updater can self-replace in place; a `.deb`/`.rpm` install would
otherwise expect updates through the system package manager instead).
Releases are created as **drafts** — nothing goes public or notifies
watchers until manually published on GitHub. The app checks for updates
once on startup (silently, no error shown if offline/unreachable) and
shows a banner with an "Update & Restart" button if a newer version is
available. Update packages are signed — CI needs `TAURI_SIGNING_PRIVATE_KEY`/
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets configured on the repo, or
the release step fails.

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
  `HTTP 500`. See `scripts/Market Sell Probe.pluto`'s header comment for
  the full writeup.
- `gameRef` on a warframe.market v2 item entry (e.g.
  `/v2/item/serration` → `gameRef: "/Lotus/Upgrades/Mods/Rifle/
  WeaponDamageAmountMod"`) is directly the real client `ItemType` path —
  no separate mapping table is needed to go from a market item to what to
  grant/remove. For relics specifically, `gameRef` is the BASE path with
  no refinement suffix — resolved to the right suffix server-side per
  order (see below).
- **CONFIRMED WORKING end-to-end for all categories (2026-09-17)** — Mods,
  Arcanes, and Relics each verified with a real in-game buy + sell round
  trip through this UI against a live SpaceNinjaServer instance.
- **Rank (mod/arcane fusion level), CONFIRMED WORKING (2026-09-17).**
  Buying at rank > 0 sends `Fingerprint: JSON.stringify({lvl: N})` on the
  grant — the same mechanism SpaceNinjaServer's own WebUI uses for its
  "acquire mod max" flow. Verified live: a rank-3 Serration appeared in
  the Mods screen after granting it through this mechanism.
- `/api/inventory.php` (used by the ranked-mod probe, and by
  `Market Sync.pluto`'s owned-count sync below) intermittently fails with
  `Connection Closed Prematurely` — measured at a real, bounded **~25-30%
  per-call failure rate** on one setup via `Market Inventory Flake
  Probe.pluto` (15 isolated calls, 4s apart: 11/15 succeeded, longest
  failure streak was 1). Response size was IDENTICAL on every success —
  exactly 305141 bytes, zero variance — and timing was fast and
  consistent on both success AND failure (55-68ms), which rules out
  payload size or a slow timeout as the cause. Root cause otherwise
  unconfirmed (no timeout knob is available on Pluto's `http.request` to
  tune). Not fixable from script-side, but bounded and well-behaved
  enough that a short retry loop (see below) lands a successful sync
  within a few seconds the large majority of the time. Expect the
  occasional run of several failures in a row as normal variance (P(4 in
  a row) ≈ 0.5% at this rate, rare but not a sign anything's actually
  wrong).
- **Retry cadence fix, 2026-09-17.** The first live run of the owned-count
  feature waited the full `INVENTORY_POLL_MS` (30s) after every failed
  attempt before retrying - at the measured flake rate, a bad-luck streak
  could leave "Owned: ?" stuck for minutes, which is a real problem in
  practice even though each individual failure is expected. Split into
  two intervals: `INVENTORY_POLL_MS` (30s) applies only after a
  **success**, `INVENTORY_RETRY_MS` (5s) applies after a **failure** -
  since the flakiness is quick/random rather than a sustained outage, a
  short retry gets a successful sync in a few seconds almost every time
  instead of potentially waiting several full 30s cycles.
- **Relic refinement, CONFIRMED WORKING (2026-09-17).** `routes.ts`
  resolves `base + {Bronze,Silver,Gold,Platinum}` server-side per order
  based on the chosen refinement, so `Market Sync.pluto` needed **zero
  changes** — it just sees an already-resolved `gameRef`, same as every
  other order. Reuses the identical already-proven `sell.php`/`addItems`
  mechanism with just a different resolved path.
- **Prime Warframe parts/sets (category `Recipes`), CONFIRMED WORKING
  (2026-09-17).** Structurally identical to the already-proven
  `Upgrades`/`MiscItems` categories, but never exercised by any script
  here before — confirmed with `Market Prime Recipe Probe.pluto`: granted
  a Prime Blueprint, visually confirmed it appeared in the Foundry's
  Blueprints tab, sold it back, visually confirmed it was gone. "Buy Full
  Set" was also verified through the real UI, resolving to a 4-part order
  with the correct bundled price sourced from the Set's own warframe.market
  listing.
- **Owned-count sync (`GET /api/owned`, `POST /internal/inventory-snapshot`),
  CONFIRMED WORKING (2026-09-17).** `Market Sync.pluto` fetches
  `GET /api/inventory.php` on its own 30s timer (separate from order
  polling) and reports a flattened `{ItemType: count}` map built from the
  response's `RawUpgrades`/`MiscItems`/`Recipes` arrays — field names/
  shapes confirmed from SpaceNinjaServer's actual `inventoryTypes.ts`, not
  guessed. The endpoint call itself was already proven (see the flakiness
  entry above); what was genuinely new here was calling it repeatedly in
  a long-running background loop instead of a one-off probe. **Not a
  safety-critical mechanism** — SpaceNinjaServer's own `sellController.ts`
  throws if a sell would take a stored count negative (confirmed from
  source: `addMiscItems`/`addRecipes`/`addMods` all guard this identically),
  so a stale/wrong/missing snapshot can at worst let a doomed Sell click
  through to a normal failed-order toast, never an actual oversell.
- **Ranked-copy breakdown + sell-by-oid, CONFIRMED WORKING (2026-09-17).**
  A ranked grant's `Fingerprint` field is stored server-side as
  `UpgradeFingerprint` on that copy's `Upgrades` collection entry (same
  `{"lvl":N}` shape) alongside its real database id (`ItemId`) - confirmed
  from SpaceNinjaServer's actual `inventoryTypes.ts`/
  `addItemsController.ts`, so parsing it back out on each inventory sync
  is the exact inverse of what the grant already writes. Selling one
  specific instance by that id takes a completely different `sell.php`
  code path than every other sell here: a `String` with no `/` in it is
  treated as a bare database id and deleted directly
  (`inventory.Upgrades.pull({_id: String})`), confirmed from
  `sellController.ts`. Verified live with `Market Ranked Sell
  Probe.pluto`: granted a rank-3 Serration, found its exact id via
  `UpgradeFingerprint`, sold it by that id, then confirmed the `Upgrades`
  entry count for Serration dropped by exactly 1 (not just "something
  changed").

## Known limitations

- **The launcher's Pluto-connected status is a heuristic, not a real
  connection check.** `Market Sync.pluto` always initiates contact; the
  server has no way to reach out to it. "Connected" just means a poll was
  seen recently (within 8s) — a script that's running but stuck/erroring
  after its initial poll could still show "Connected" for up to 8s after
  it actually stopped doing anything useful. Check the terminal panel /
  the Bootstrapper's `script_log` for actual script health, not just this
  chip.
- **No launcher release published yet** — the GitHub Actions workflow
  exists but has never actually been run (no tag pushed yet as of
  2026-09-18) — has to be built from source until then.
- **Linux support is source-verified, not build-verified.** The CI
  workflow targets `ubuntu-22.04` and produces an AppImage, and the one
  known Windows-only code path (hiding the server's console window) is
  properly `#[cfg(target_os = "windows")]`-gated, but no one has actually
  run a build on a real Linux machine yet — the first tagged release will
  be the first real test.
- **"Peculiar" mods were miscategorized as Arcanes until fixed 2026-09-18.**
  The 4 Peculiar mods (Growth/Bloom/Audience/End) carry BOTH `"mod"` and
  `"arcane_enhancement"` tags simultaneously on warframe.market — the only
  items with that overlap (confirmed by downloading the full catalog, not
  guessed). Classification checked `arcane_enhancement` first, so these
  landed under Arcanes; reordered so `mod` wins the ambiguous case,
  matching what they actually are (Warframe-slot mods).
- **Rivens are deliberately excluded entirely.** A filter bug (checking
  for the exact tag `"riven"` instead of any tag containing `"riven"`)
  let 7 "Veiled Riven Mod" placeholders slip through until fixed
  2026-09-17 — selling one from the shop would have decremented the same
  stackable ItemType a player's real earned-in-game veiled Rivens live
  in, indistinguishably. Fixed; rivens (rolled or veiled) should never
  appear in `/api/items` now.
- No unique-instance gear yet (weapon/Warframe skins turned out not to be
  tradeable on warframe.market at all — checked, not guessed — so
  Syndicate armor pieces are the concrete remaining candidate if this is
  ever picked up; would need `/api/inventory.php`-based oid resolution).
- Selling a specific ranked mod/arcane copy is only possible through the
  "▸ N owned at other ranks" breakdown, not the main row's Sell button
  (which always targets plain rank-0 stock).
- Prime Warframe parts only — weapon Prime parts are deferred (2-5 parts
  by weapon type vs. Warframes' fixed 4, more shapes to handle correctly).
- Selling a full Prime set isn't supported — only individual parts can be
  sold back. A deliberate scope choice, not a technical block: it also
  matches how a player would realistically use this anyway (you wouldn't
  buy a whole set through the shop only to immediately resell it as one
  unit).
- No persistence — a backend restart drops any in-flight order. Fine for
  a personal single-account tool; add real storage first if you want to
  build on top of this.
- Owned counts can lag reality by up to 30s after a change made outside
  this shop (e.g. selling something through the real in-game Market UI
  instead). Buy/sell orders placed through this shop itself update the
  displayed count instantly (optimistic local adjustment) — only outside
  changes wait for the next sync.
- This is a fake economy. Prices come from warframe.market but the
  platinum/items themselves are self-granted, not tied to any other real
  player or account.

## License

MIT — see [LICENSE](LICENSE).
