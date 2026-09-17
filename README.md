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

## Why Node/Express/TypeScript

SpaceNinjaServer's own backend is Node/Express/TypeScript. Keeping this in
the same stack means the mapping/pricing/order logic here could realistically
be adapted into a page inside SpaceNinjaServer's own WebUI by someone who
wanted that, rather than needing a rewrite.

## Frontend

Real pagination (40 items/page — 2000+ items exist across all four
categories), a type filter (All/Mods/Arcanes/Relics/Primes), and a
List/Grid view toggle. Grid view is pure CSS on the same row markup as
List — toggling between them never re-fetches prices.

Mods/Arcanes get a rank stepper (shown as e.g. "3 of 10") that live-updates
the displayed price from warframe.market's per-rank order data — buying
grants the exact rank shown. **Selling stays rank-0 only**: a specific
ranked copy can't be sold back (would need `/api/inventory.php`-based
database-id resolution), so Sell auto-disables whenever a nonzero rank is
selected.

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

## Setup

1. **Backend**
   ```
   cd server
   npm install
   npm start
   ```
   Listens on `http://127.0.0.1:7890/` by default (override with the
   `MARKET_EMULATOR_PORT` env var).

2. **Script** — copy `scripts/Market Sync.pluto` into your OpenWF
   `Scripts/` folder and start it in-game (or autostart it). It polls the
   backend and executes queued orders against SpaceNinjaServer. It does
   nothing harmful if the backend isn't reachable — just a failed request
   every couple seconds.

3. **Open the shop** — `http://127.0.0.1:7890/` in a browser while the
   game is running. Search a mod, hit Buy or Sell.

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
  enough that a 30s retry-on-failure loop (what `Market Sync.pluto`
  already does) lands a successful sync within 1-2 cycles the large
  majority of the time. Treat a failed read as "try again," and expect
  the occasional run of several failures in a row as normal variance
  (P(4 in a row) ≈ 0.5% at this rate, rare but not a sign anything's
  actually wrong).
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

## Known limitations

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
- Selling a specific ranked mod/arcane copy isn't supported — Sell always
  targets the plain rank-0 stock (same oid-resolution gap as unique-
  instance gear above).
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
