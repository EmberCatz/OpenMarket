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

**Scope: Mods + Arcanes + Intact Relics.** Mods/Arcanes route through
SpaceNinjaServer's identical `addMods()`/`RawUpgrades` mechanism
server-side (category `Upgrades`); Relics are plain `MiscItems`-category
stackable grants (Intact quality only — warframe.market's `gameRef` for a
relic is the base path with no refinement suffix, so this app appends
`Bronze` itself). See [Known limitations](#known-limitations) for what's
not covered yet.

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

Real pagination (40 items/page — 2000+ items exist across all three
categories), a type filter (All/Mods/Arcanes/Relics), and a List/Grid view
toggle. Grid view is pure CSS on the same row markup as List — toggling
between them never re-fetches prices.

Mods/Arcanes also get a rank stepper (0..maxRank) that live-updates the
displayed price from warframe.market's per-rank order data — buying grants
the exact rank shown. **Selling stays rank-0 only**: a specific ranked copy
can't be sold back (would need `/api/inventory.php`-based database-id
resolution), so Sell auto-disables whenever a nonzero rank is selected.

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
  no refinement suffix — this app appends `Bronze` (Intact) itself.
- **CONFIRMED WORKING end-to-end for all three categories (2026-09-17)** —
  Mods, Arcanes, and Relics each verified with a real in-game buy + sell
  round trip through this UI against a live SpaceNinjaServer instance.
- **Rank (mod/arcane fusion level), CONFIRMED WORKING (2026-09-17).**
  Buying at rank > 0 sends `Fingerprint: JSON.stringify({lvl: N})` on the
  grant — the same mechanism SpaceNinjaServer's own WebUI uses for its
  "acquire mod max" flow. Verified live: a rank-3 Serration appeared in
  the Mods screen after granting it through this mechanism.
- `/api/inventory.php` (used only by the ranked-mod probe, not by the
  live buy/sell path) intermittently fails with `Connection Closed
  Prematurely` when fetched twice in close succession — a real but
  occasional quirk of that large response, not a bug in the request
  itself. Treat a failed read as "try again."

## Known limitations

- No weapon/warframe skins or prime parts yet — unique-instance gear needs
  `/api/inventory.php`-based database-id resolution, a bigger lift than
  the path-based items above.
- Relics are Intact quality only — no Exceptional/Flawless/Radiant
  refinement selection yet.
- Selling a specific ranked mod/arcane copy isn't supported — Sell always
  targets the plain rank-0 stock (same oid-resolution gap as unique-
  instance gear above).
- No persistence — a backend restart drops any in-flight order. Fine for
  a personal single-account tool; add real storage first if you want to
  build on top of this.
- This is a fake economy. Prices come from warframe.market but the
  platinum/items themselves are self-granted, not tied to any other real
  player or account.

## License

MIT — see [LICENSE](LICENSE).
