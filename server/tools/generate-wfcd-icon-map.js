// One-off generator for wfcd-icon-map.json - run manually whenever
// @wfcd/items is bumped (`npm update @wfcd/items` in server/), not on
// every server start (same precedent as generate-icon-paths.js).
//
// Builds one flat gameRef -> imageName map from the @wfcd/items npm
// package (github.com/WFCD/warframe-items) - an actively-maintained,
// MIT-licensed dataset pulled from Warframe's own API, refreshed on every
// game update. It exposes each item's real in-game unique path as
// `uniqueName`, which is the EXACT SAME "/Lotus/..." string this app
// already uses as `gameRef` everywhere else (confirmed directly against
// this app's own prime-warframe-sets.json/prime-weapon-sets.json entries
// and against ExportUpgrades.json/ExportArcanes.json gameRefs, 2026-09-26)
// - no name-matching or fuzzy lookup needed, just a direct key match.
//
// This map feeds itemsCache.ts's iconUrl() as a THIRD tier: local
// Warframe-Exporter extraction (localIcons.ts, fully offline) is still
// preferred when present, but for anything not yet extracted, this map's
// `https://cdn.warframestat.us/img/${imageName}` (see @wfcd/items'
// README "Image links" section) is tried BEFORE the existing browse.wf
// fallback - it's the CDN @wfcd/items itself documents as the linkable
// resource for its imageName field, actively maintained by the same
// project that ships this data, vs. browse.wf being an unaffiliated
// community mirror. Both are still just opportunistic network fallbacks -
// local extraction and the <img onerror> chain to the placeholder are
// unchanged.
//
// Relics need the same Bronze-suffix stripping generate-icon-paths.js
// already does for the local Public Export dump: @wfcd/items' relic
// uniqueNames carry the exact same Bronze/Silver/Gold/Platinum refinement
// suffixes (confirmed against T4VoidProjectionEBronze etc., 2026-09-26),
// but this app's relic MarketItems key on the bare intact/Bronze gameRef
// with the suffix already stripped - so this map needs it stripped too,
// or every relic would simply never match and silently fall through to
// browse.wf instead (not wrong, just wasting this tier for the one
// category that needs the same normalization as the local map already
// gets).
//
// Deliberately NOT filtered down to only this app's real Prime-set/mod/
// arcane subset the way generate-icon-paths.js filters Warframes/Weapons
// (see that file's header for why THAT filtering matters there - slow
// bulk CLI extraction of huge unrelated folders). Building this map is a
// single in-memory pass over already-fetched JSON, so keeping every
// category's entries costs nothing at runtime (only ever looked up by
// gameRef, unused keys just sit there) and is far simpler than
// re-deriving the same filtering logic a second time from a different
// data source.
//
// Run from market-emulator/server/: node tools/generate-wfcd-icon-map.js

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Items from "@wfcd/items";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "../wfcd-icon-map.json");

const REFINEMENT_SUFFIXES = ["Bronze", "Silver", "Gold", "Platinum"];

const items = new Items({ category: ["All"] });

const iconMap = {};
let relicsStripped = 0;

for (const item of items) {
    if (typeof item?.uniqueName !== "string" || typeof item?.imageName !== "string") continue;

    let gameRef = item.uniqueName;
    if (item.category === "Relics") {
        const suffix = REFINEMENT_SUFFIXES.find(s => gameRef.endsWith(s));
        if (suffix) {
            // Same reasoning as generate-icon-paths.js's addRelics(): only
            // the Bronze/intact tier's art is kept, under the
            // suffix-stripped gameRef this app actually looks up relics
            // by. The other 3 refinements' entries are simply skipped
            // (not written under any key) rather than overwriting the
            // Bronze entry in whatever order @wfcd/items happens to
            // iterate them.
            if (suffix !== "Bronze") continue;
            gameRef = gameRef.slice(0, -suffix.length);
            relicsStripped++;
        }
    }

    iconMap[gameRef] = item.imageName;
}

writeFileSync(OUT_PATH, JSON.stringify(iconMap, null, 2) + "\n");
console.log(`Wrote ${Object.keys(iconMap).length} gameRef -> imageName entries to ${OUT_PATH} (${relicsStripped} relics normalized to their Bronze/intact gameRef).`);
