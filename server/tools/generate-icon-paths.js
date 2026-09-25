// One-off generator for icon-paths.json - run manually whenever the local
// Public Export dumps are refreshed, not on every server start (same
// precedent as generate-prime-sets.js/generate-prime-weapon-sets.js).
//
// Builds one flat gameRef -> internal Public Export icon path map, merging
// every export file this app's catalog can resolve an icon through:
//
// - ExportWarframes.json / ExportWeapons.json: filtered down to ONLY the
//   real prime-warframe-sets.json/prime-weapon-sets.json setGameRefs (50
//   and 87 respectively) - NOT every entry in these two files. Both
//   exports also contain every BASE (non-Prime) frame/weapon, which this
//   app never sells and whose icons live in entirely separate folders
//   (e.g. base Volt -> .../StoreIcons/Warframes/Volt.png, distinct from
//   VoltPrime -> .../StoreIcons/Primes/VoltPrime.png) - including them
//   here would make localIcons.ts bulk-extract folders full of icons
//   nothing in this app's catalog ever references. Confirmed by checking
//   all 50/87 real set gameRefs against these files, not assumed.
// - ExportUpgrades.json: mods' real gameRef (e.g. "/Lotus/Upgrades/Mods/
//   Rifle/WeaponDamageAmountMod") is the key directly, icon under
//   "/Lotus/Interface/Cards/Images/...".
// - ExportArcanes.json: real Arcanes are a SEPARATE export from mods (a
//   different internal tree, "/Lotus/Upgrades/CosmeticEnhancers/..."),
//   icon under "/Lotus/Interface/Icons/CosmeticEnhancers/Arcanes/...".
//   Confirmed distinct from ExportUpgrades.json's own
//   CosmeticEnhancers/Peculiars entries (the "Peculiar" mods that carry
//   both "mod" and "arcane_enhancement" tags on warframe.market - those
//   stay classified as mods in itemsCache.ts and resolve their icon via
//   ExportUpgrades.json like any other mod, not through this file).
// - ExportRelics.json: NO entry in this file uses the bare gameRef this
//   app's relic MarketItems actually key on - EVERY relic is stored as 4
//   separate refinement-suffixed entries (...Bronze/Silver/Gold/
//   Platinum), confirmed by checking multiple relics across different
//   eras, not assumed. Each refinement also points to a DIFFERENT icon -
//   but that icon is a generic per-era-per-quality shape (e.g. every
//   single Lith relic's Bronze entry points to the same RelicLithD.png,
//   regardless of which specific relic it is - there is no per-relic-name
//   unique art, matching real in-game behavior where relics only look
//   different by name/text, not artwork). So: strip the "Bronze" suffix
//   (== itemsCache.ts's RELIC_REFINEMENT_SUFFIXES.intact, this app's
//   default refinement) to recover the base gameRef this app actually
//   uses, and use that entry's icon as this relic's one representative
//   icon - Silver/Gold/Platinum's own (differently-shaped but equally
//   generic) icons are simply unused, since this app never looks up a
//   relic by its refined path for icon purposes.
//
// Individual Prime weapon/Warframe PART blueprints (Barrel/Receiver/
// Chassis/etc., under "/Lotus/Types/Recipes/...") are deliberately NOT in
// this map - checked, they carry no `icon` field anywhere in Public
// Export (real in-game behavior: a part blueprint shows a generic
// blueprint icon, not unique art). Those rows just get no local icon.
//
// All 5 folder families below were confirmed extractable via
// Warframe-Exporter-CLI's --ls against a real Cache.Windows (2026-09-25) -
// see server/src/localIcons.ts's ICON_CATEGORIES for the extraction side.
//
// Run from market-emulator/server/: node tools/generate-icon-paths.js

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUMPS_DIR = path.join(__dirname, "../../../database_scrapes/warframe-public-export-plus-senpai");
const OUT_PATH = path.join(__dirname, "../icon-paths.json");

function loadExport(file) {
    return JSON.parse(readFileSync(path.join(DUMPS_DIR, file), "utf8"));
}

const iconPaths = {};

function addFiltered(file, allowedGameRefs) {
    const entries = loadExport(file);
    let count = 0;
    for (const gameRef of allowedGameRefs) {
        const icon = entries[gameRef]?.icon;
        if (typeof icon === "string") {
            iconPaths[gameRef] = icon;
            count++;
        }
    }
    console.log(`${file}: ${count}/${allowedGameRefs.length} real gameRefs matched with an icon field`);
}

function addAll(file) {
    const entries = loadExport(file);
    let count = 0;
    for (const [gameRef, entry] of Object.entries(entries)) {
        if (entry && typeof entry.icon === "string") {
            iconPaths[gameRef] = entry.icon;
            count++;
        }
    }
    console.log(`${file}: ${count} entries with an icon field`);
}

const REFINEMENT_SUFFIXES = ["Bronze", "Silver", "Gold", "Platinum"];

function addRelics(file) {
    const entries = loadExport(file);
    let refined = 0,
        standalone = 0;
    for (const [gameRef, entry] of Object.entries(entries)) {
        if (typeof entry?.icon !== "string") continue;
        const suffix = REFINEMENT_SUFFIXES.find(s => gameRef.endsWith(s));
        if (suffix) {
            // Only the Bronze/intact entry - see this file's header
            // comment for why the other 3 refinements' icons are unused.
            if (suffix !== "Bronze") continue;
            iconPaths[gameRef.slice(0, -suffix.length)] = entry.icon;
            refined++;
        } else {
            // A small number of relics (e.g. the single-tier "Immortal"
            // reward-track ones) have no refinement suffix at all -
            // already the exact gameRef this app uses, no stripping
            // needed.
            iconPaths[gameRef] = entry.icon;
            standalone++;
        }
    }
    console.log(`${file}: ${refined} refined relics (via Bronze/intact) + ${standalone} standalone/single-tier relics`);
}

const primeWarframeSets = JSON.parse(readFileSync(path.join(__dirname, "../prime-warframe-sets.json"), "utf8"));
const primeWeaponSets = JSON.parse(readFileSync(path.join(__dirname, "../prime-weapon-sets.json"), "utf8"));

addFiltered(
    "ExportWarframes.json",
    primeWarframeSets.map(s => s.setGameRef)
);
addFiltered(
    "ExportWeapons.json",
    primeWeaponSets.map(s => s.setGameRef)
);
// Mods/Arcanes/Relics have no equivalent "real subset" list available
// offline (unlike Prime sets, there's no local file enumerating exactly
// which of these are actually tradeable) - every icon-bearing entry in
// these 3 files is included as-is. This is fine in practice: unlike
// Warframes/Weapons, there's no large "base version nobody sells" split
// here inflating the count.
addRelics("ExportRelics.json");
addAll("ExportUpgrades.json");
addAll("ExportArcanes.json");

writeFileSync(OUT_PATH, JSON.stringify(iconPaths, null, 2) + "\n");
console.log(`Wrote ${Object.keys(iconPaths).length} gameRef -> icon path entries to ${OUT_PATH}`);
