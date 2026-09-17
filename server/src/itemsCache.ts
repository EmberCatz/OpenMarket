// In-memory cache of everything this app can buy/sell, refreshed hourly.
// Two families, both plain path+count operations server-side (no oid/
// inventory.php resolution needed - see README.md's "Confirmed HTTP
// mechanics" for the source-verified writeup of why):
//
// - Mods + Arcanes (category "Upgrades"): both route through
//   SpaceNinjaServer's identical addMods()/RawUpgrades mechanism. Tagged
//   "mod" or "arcane_enhancement" on warframe.market (NOT "arcane").
// - Relics (category "MiscItems"), Intact quality only: warframe.market's
//   gameRef for a relic is the BASE path with no refinement suffix -
//   confirmed against the local Public Export dump that appending
//   "Bronze" (Intact) produces a real grantable path, e.g. gameRef
//   ".../T1VoidProjectionG" + "Bronze" = ".../T1VoidProjectionGBronze"
//   ("Lith A1", verified 2026-09-17). Exceptional/Flawless/Radiant
//   (Silver/Gold/Platinum) are a real possible extension later but not
//   built - would need a per-item refinement selector in the UI.
//
// `category` and `defaultSubtype` ride along on each entry so the price
// lookup (which needs the right warframe.market order subtype) and the
// sell call (which needs the right SpaceNinjaServer Items.<category> key)
// don't have to re-derive them from the item's tags/path again later.
// `type` is the UI-facing grouping (Mods and Arcanes share `category`
// "Upgrades" server-side, but a user filtering the shop wants them split).

import { fetchAllItems, type WfmItemEntry } from "./warframeMarketApi.js";

export type ItemCategory = "Upgrades" | "MiscItems";
export type ItemType = "mod" | "arcane" | "relic";

export interface MarketItem {
    slug: string;
    gameRef: string;
    name: string;
    icon: string | null;
    category: ItemCategory;
    type: ItemType;
    defaultSubtype: string; // the warframe.market order "subtype" this item's price/grant corresponds to
}

const REFRESH_MS = 60 * 60 * 1000; // 1 hour
const RELIC_INTACT_SUFFIX = "Bronze";

let cache: MarketItem[] = [];
let cachedAt = 0;
let refreshing: Promise<MarketItem[]> | null = null;

function iconUrl(icon: string | undefined): string | null {
    return icon ? `https://warframe.market/static/assets/${icon}` : null;
}

function classify(item: WfmItemEntry): MarketItem | null {
    const en = item.i18n.en;
    if (!en || !item.gameRef) return null;

    if (item.tags.includes("arcane_enhancement") && !item.tags.includes("riven")) {
        return {
            slug: item.slug,
            gameRef: item.gameRef,
            name: en.name,
            icon: iconUrl(en.icon),
            category: "Upgrades",
            type: "arcane",
            defaultSubtype: "regular"
        };
    }

    if (item.tags.includes("mod") && !item.tags.includes("riven")) {
        return {
            slug: item.slug,
            gameRef: item.gameRef,
            name: en.name,
            icon: iconUrl(en.icon),
            category: "Upgrades",
            type: "mod",
            defaultSubtype: "regular"
        };
    }

    if (item.tags.includes("relic")) {
        return {
            slug: item.slug,
            gameRef: item.gameRef + RELIC_INTACT_SUFFIX,
            name: `${en.name} (Intact)`,
            icon: iconUrl(en.icon),
            category: "MiscItems",
            type: "relic",
            defaultSubtype: "intact"
        };
    }

    return null;
}

async function refresh(): Promise<MarketItem[]> {
    const all = await fetchAllItems();
    cache = all.map(classify).filter((m): m is MarketItem => m !== null);
    cachedAt = Date.now();
    return cache;
}

export async function getItems(): Promise<MarketItem[]> {
    if (Date.now() - cachedAt < REFRESH_MS && cache.length > 0) {
        return cache;
    }
    if (!refreshing) {
        refreshing = refresh().finally(() => {
            refreshing = null;
        });
    }
    return refreshing;
}

export async function findItemByGameRef(gameRef: string): Promise<MarketItem | undefined> {
    const items = await getItems();
    return items.find(m => m.gameRef === gameRef);
}
