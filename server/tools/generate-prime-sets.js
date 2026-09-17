// One-off generator for prime-warframe-sets.json - run manually whenever
// new Primes ship, not on every server start (mirrors the RELIC_POOLS
// extraction precedent used elsewhere in this project: programmatic
// extraction from the local Public Export dumps, not hand-typed).
//
// TWO-STAGE crafting chain, confirmed from source (not assumed) after an
// earlier version of this script got it wrong: the main Warframe
// blueprint's ingredients[] lists the FINISHED component paths (e.g.
// ".../VoltPrimeSystemsComponent", productCategory MiscItems) - but that
// finished form is NOT what players trade. What's actually tradeable is
// a SEPARATE recipe (".../VoltPrimeSystemsBlueprint") whose OWN
// resultType equals that finished component path - building it consumes
// real resources (Control Module/Orokin Cell/Salvage/Circuits, NOT
// tradeable parts) to produce the finished, non-tradeable component. So
// all 4 real tradeable "parts" of a set (main blueprint + 3 component
// blueprints) are ExportRecipes entries - there is no MiscItems item
// anywhere in the real tradeable chain, despite what the finished
// components' own productCategory suggests.
//
// The main blueprint's ingredients[] ALSO includes raw crafting resources
// (e.g. Orokin Cells) alongside the 3 real components - filtered out via
// the same discriminator as before: a real component's parentName is
// exactly "/Lotus/Types/Items/MiscItems/WarframeComponentItem" (confirmed
// from ExportResources.json); Orokin Cell and friends have a different
// parentName. Checked across all 50 Prime Warframe blueprints - every one
// has EXACTLY 3 such component ingredients, no exceptions, and every one
// of those 3 finished components has exactly one recipe whose resultType
// points back to it.
//
// Run from market-emulator/server/: node tools/generate-prime-sets.js

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUMPS_DIR = path.join(__dirname, "../../../database_scrapes/warframe-public-export-plus-senpai");
const OUT_PATH = path.join(__dirname, "../prime-warframe-sets.json");

const recipes = JSON.parse(readFileSync(path.join(DUMPS_DIR, "ExportRecipes.json"), "utf8"));
const resources = JSON.parse(readFileSync(path.join(DUMPS_DIR, "ExportResources.json"), "utf8"));

const PRIME_FRAME_RESULT_RE = /^\/Lotus\/Powersuits\/[^/]+\/[^/]+Prime$/;
const COMPONENT_PARENT = "/Lotus/Types/Items/MiscItems/WarframeComponentItem";

// Reverse index: finished-component path -> the recipe that BUILDS it
// (the actual tradeable Blueprint). Built once up front since multiple
// frames' lookups all draw from the same ExportRecipes.json.
const recipeByResultType = new Map();
for (const [recipePath, recipe] of Object.entries(recipes)) {
    if (typeof recipe.resultType === "string") {
        recipeByResultType.set(recipe.resultType, recipePath);
    }
}

const sets = [];
for (const [blueprintPath, recipe] of Object.entries(recipes)) {
    if (typeof recipe.resultType !== "string" || !PRIME_FRAME_RESULT_RE.test(recipe.resultType)) continue;

    const finishedComponentPaths = (recipe.ingredients || [])
        .filter(ing => resources[ing.ItemType]?.parentName === COMPONENT_PARENT)
        .map(ing => ing.ItemType);

    if (finishedComponentPaths.length !== 3) {
        console.warn(`Skipping ${blueprintPath}: expected 3 real components, found ${finishedComponentPaths.length}`);
        continue;
    }

    // Each finished component isn't itself tradeable - resolve to the
    // separate Blueprint recipe that builds it, which IS the real
    // tradeable item.
    const componentBlueprintPaths = finishedComponentPaths.map(finishedPath => recipeByResultType.get(finishedPath));
    if (componentBlueprintPaths.some(p => !p)) {
        console.warn(`Skipping ${blueprintPath}: couldn't find a building recipe for one or more components`);
        continue;
    }

    // All 4 real tradeable parts (main blueprint + 3 component
    // blueprints) are ExportRecipes entries - confirmed from source, the
    // finished components' own MiscItems form is never what's traded.
    sets.push({
        setGameRef: recipe.resultType,
        parts: [blueprintPath, ...componentBlueprintPaths].map(gameRef => ({ gameRef, category: "Recipes" }))
    });
}

sets.sort((a, b) => a.setGameRef.localeCompare(b.setGameRef));

writeFileSync(OUT_PATH, JSON.stringify(sets, null, 2) + "\n");
console.log(`Wrote ${sets.length} Prime Warframe sets to ${OUT_PATH}`);
