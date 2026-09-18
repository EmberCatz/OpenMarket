# OpenMarket — an OpenWF Market Emulator

A local, personal **shop** for [OpenWF](https://onlyg.it/OpenWF)-based
Warframe private servers, priced off real
[warframe.market](https://warframe.market) data. Search for an item, hit
Buy or Sell, and it's instantly granted or removed along with platinum —
no other player involved. Think of it as a single-player vending machine
stocked with real market prices, not an actual trading system.

Not affiliated with Digital Extremes, Warframe, warframe.market, OpenWF,
or SpaceNinjaServer. Requires an OpenWF Bootstrapper client and a
SpaceNinjaServer instance you already control — it does not work against
the real Warframe servers.

## Features

- **Mods, Arcanes, Relics, and Prime Warframe parts/sets** — buy and sell
  at any rank (mods/arcanes) or refinement (relics).
- **Real prices**, refreshed weekly from warframe.market's historical
  order data — not made up, not live-fetched on every click.
- **Live owned counts**, synced from your actual SpaceNinjaServer
  inventory, so Sell auto-disables on things you don't have.
- **Sort and filter** by name, type, price, rarity, relic era, or owned
  status; List and Grid views.
- **Desktop launcher** (Windows/Linux) that starts the backend for you,
  shows connection status, and streams logs — no terminal required.

Not covered (yet): weapon Prime parts (Warframes only for now), skins/
cosmetics, and selling a full Prime set as one unit. See
[DEVLOG.md](DEVLOG.md#known-limitations) for the complete list and why.

## Requirements

- Node.js 18+
- An OpenWF Bootstrapper install pointed at a SpaceNinjaServer instance
  you control

## Quick start

**Easiest**: grab the [desktop launcher](#desktop-launcher) — it handles
setup and starting the backend for you.

**Manual**:

```
cd server
npm install
npm start
```

Then copy `scripts/Market Sync.pluto` into your OpenWF `Scripts/` folder
and start it in-game — it's what actually talks to SpaceNinjaServer.
Open `http://127.0.0.1:7890/` in a browser while the game is running,
search for something, and hit Buy or Sell.

## Desktop launcher

`launcher/` is a small desktop app (Windows + Linux) that runs the
backend for you instead of a terminal window: one button to install
dependencies and launch, a status dashboard (server / price database /
script connection), and a live log view.

Download a release from the [Releases page](../../releases) once one's
published — Windows has two options: an installer (auto-updates itself)
or a portable `.zip` (extract anywhere, just run the exe, but you'll
need to manually grab new versions). Linux ships as an AppImage
(auto-updates). Either way, you'll need [Node.js](https://nodejs.org/)
18+ installed — the launcher checks for it and tells you if it's
missing, but doesn't install it for you.

Or build it yourself:

```
cd launcher
npm install
npm run tauri dev      # or: npm run tauri build
```

Building from source needs [Rust](https://rustup.rs/) in addition to
Node — a downloaded release doesn't.

## How it works

```
Browser  <-->  server/ (Node/Express)  <-->  warframe.market (read-only, prices)
                    ^  |
                    |  v
          scripts/Market Sync.pluto  <-->  SpaceNinjaServer
```

The backend never talks to SpaceNinjaServer directly — only the Pluto
script running inside the game does. The backend just queues up what you
clicked; the script polls for it and carries it out. This all runs on
`localhost` for one account — don't expose it to the network.

For the full architecture rationale, every confirmed API mechanism, and
a detailed history of what's been built and fixed, see
[DEVLOG.md](DEVLOG.md).

## Known limitations

- No weapon Prime parts yet — Warframes only.
- No unique-instance cosmetics (skins) — warframe.market doesn't carry
  trade data for those at all.
- Can't sell a full Prime set as one unit, only its individual parts.
- No persistence — restarting the backend drops any order in progress.
- This is a fake economy: prices are real, but the platinum and items
  are self-granted, not tied to any other player or account.

More detail on each of these, plus smaller edge cases, in
[DEVLOG.md](DEVLOG.md#known-limitations).

## License

MIT — see [LICENSE](LICENSE).
