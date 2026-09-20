// One-off generator for prime-weapon-sets.json - run manually whenever new
// Prime weapons ship (mirrors generate-prime-sets.js's Warframe precedent).
// Run from market-emulator/server/: node tools/generate-prime-weapon-sets.js
//
// UNLIKE Prime Warframes (always exactly 4 parts: main Blueprint + 3
// component Blueprints, needing a two-stage resolution because a
// Warframe's finished components aren't themselves tradeable), a weapon's
// physical components ARE directly tradeable Recipes already - e.g.
// ".../BratonPrimeBarrel" is itself the real tradeable part, no separate
// "builds a finished component" indirection to resolve. But part COUNT
// varies by weapon type - confirmed from source across all 87 real Prime
// weapon blueprints in ExportRecipes.json (2026-09-20), not assumed from
// a single example: 2 parts (most pistols), 3 (most rifles/melee -
// Barrel/Receiver/Stock or Blade/Handle/Guard), or 4 (Bow/Zhuge -
// String/Grip/UpperLimb/LowerLimb).
//
// TWO further wrinkles, also confirmed from source rather than assumed:
//
// 1. Some ingredients need MORE than 1 of the same real part - e.g. a
//    dual-wielded melee weapon needing 2x Blade + 2x Handle, or a genuine
//    Akimbo pistol (Afuris/Akarius/Akbolto/Akjagara/Aksomati/Akstiletto)
//    needing 2x Barrel + 2x Receiver alongside one shared Blueprint + one
//    Link. ItemCount is read and each real part duplicated that many
//    times into `parts`, unlike the Warframe generator where every
//    ingredient is exactly ItemCount 1.
//
// 2. A rarer case (4 of the 87: Akbronco/Aklex/Akmagnus/Akvasto Prime):
//    these Akimbo pistols are built from 2 complete copies of an
//    ALREADY-EXISTING single Prime pistol's own FINISHED weapon path
//    (e.g. Akmagnus Prime's ingredients are 2x the finished
//    ".../PrimeMagnusWeapon" path + 1x AkmagnusPrimeLink), not a
//    WeaponParts recipe. That finished weapon path is never itself
//    tradeable (built weapons can't be traded) - what's actually
//    tradeable for it is Magnus Prime's own 3-part set (Blueprint/
//    Barrel/Receiver), so this generator recurses one level into that
//    inner set's own PrimeBlueprint recipe and flattens ITS real parts
//    (each duplicated by the outer ItemCount) into this set's parts list
//    instead of leaving an unresolvable finished-weapon path in there.
//    Recursion is capped at one level - confirmed no case needs a second.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUMPS_DIR = path.join(__dirname, "../../../database_scrapes/warframe-public-export-plus-senpai");
const OUT_PATH = path.join(__dirname, "../prime-weapon-sets.json");

const recipes = JSON.parse(readFileSync(path.join(DUMPS_DIR, "ExportRecipes.json"), "utf8"));

const WEAPON_PARTS_PREFIX = "/Lotus/Types/Recipes/Weapons/WeaponParts/";
const PRIME_BLUEPRINT_RE = /^\/Lotus\/Types\/Recipes\/Weapons\/[^/]+PrimeBlueprint$/;

// Reverse index: finished weapon path -> the recipe that BUILDS it. Only
// needed for the Akimbo-from-single-Prime case (wrinkle 2 above).
const recipeByResultType = new Map();
for (const [recipePath, recipe] of Object.entries(recipes)) {
    if (typeof recipe.resultType === "string") {
        recipeByResultType.set(recipe.resultType, recipePath);
    }
}

// Resolves one ingredient into 0+ real tradeable part gameRefs, duplicated
// per ItemCount. Returns [] for a raw crafting resource (e.g. Orokin
// Cell) - confirmed the ONLY non-part ingredient type across all 87 real
// Prime weapon blueprints, so no further discriminator is needed here.
function resolveIngredientParts(ingredient, depth = 0) {
    const { ItemType, ItemCount } = ingredient;
    let single;
    if (ItemType.startsWith(WEAPON_PARTS_PREFIX)) {
        single = [ItemType];
    } else if (ItemType.startsWith("/Lotus/Weapons/") && depth === 0) {
        const innerBlueprintPath = recipeByResultType.get(ItemType);
        if (!innerBlueprintPath) {
            console.warn(`No building recipe found for referenced weapon ${ItemType}`);
            return [];
        }
        const innerIngredients = recipes[innerBlueprintPath].ingredients || [];
        single = [innerBlueprintPath, ...innerIngredients.flatMap(i => resolveIngredientParts(i, depth + 1))];
    } else {
        return [];
    }
    return Array(ItemCount).fill(single).flat();
}

const sets = [];
for (const [blueprintPath, recipe] of Object.entries(recipes)) {
    if (!PRIME_BLUEPRINT_RE.test(blueprintPath)) continue;
    if (typeof recipe.resultType !== "string") continue;

    const realParts = (recipe.ingredients || []).flatMap(i => resolveIngredientParts(i));
    if (realParts.length === 0) {
        console.warn(`Skipping ${blueprintPath}: no real parts resolved`);
        continue;
    }

    // Parts intentionally CAN repeat the same gameRef (see wrinkles above) -
    // itemsCache.ts's buildPrimeCategoryItems() dedupes for the flat
    // per-part catalog rows while keeping every duplicate for the actual
    // grant list.
    sets.push({
        setGameRef: recipe.resultType,
        parts: [blueprintPath, ...realParts].map(gameRef => ({ gameRef, category: "Recipes" }))
    });
}

sets.sort((a, b) => a.setGameRef.localeCompare(b.setGameRef));

writeFileSync(OUT_PATH, JSON.stringify(sets, null, 2) + "\n");
console.log(`Wrote ${sets.length} Prime weapon sets to ${OUT_PATH}`);
