// In-memory cache of everything this app can buy/sell, refreshed hourly.
// Three families, all plain path+count operations server-side (no oid/
// inventory.php resolution needed - see README.md's "Confirmed HTTP
// mechanics" for the source-verified writeup of why):
//
// - Mods + Arcanes (category "Upgrades"): both route through
//   SpaceNinjaServer's identical addMods()/RawUpgrades mechanism. Tagged
//   "mod" or "arcane_enhancement" on warframe.market (NOT "arcane"). Rank
//   (fusion level) is set via a Fingerprint on the grant - see
//   Market Sync.pluto's doBuy() - which is why rank>0 buys land in the
//   unique-instance Upgrades collection and can't be sold back generically.
// - Relics (category "MiscItems"): warframe.market's gameRef for a relic
//   is the BASE path with no refinement suffix - confirmed against the
//   local Public Export dump that appending a suffix produces a real
//   grantable path per refinement, e.g. ".../T1VoidProjectionG" +
//   "Bronze" = ".../T1VoidProjectionGBronze" ("Lith A1", Intact, verified
//   2026-09-17). UNLIKE mod rank, refinement does NOT create a unique
//   instance - each refinement is just a different plain stackable
//   MiscItems ItemType, so buy AND sell both work at any refinement via
//   the same path+count mechanism already proven. `routes.ts` resolves
//   the base gameRef + chosen refinement into the final grantable path at
//   order-creation time, so Market Sync.pluto never needs to know
//   refinement exists at all - it just sees a fully-resolved gameRef,
//   identical to every other order.
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

// warframe.market's subtype names -> the real client path suffix for that
// relic refinement. Source: ExportRelics.json (local Public Export dump),
// cross-referenced against warframe.market's own subtype vocabulary.
export const RELIC_REFINEMENT_SUFFIXES: Record<string, string> = {
    intact: "Bronze",
    exceptional: "Silver",
    flawless: "Gold",
    radiant: "Platinum"
};
const DEFAULT_RELIC_REFINEMENTS = Object.keys(RELIC_REFINEMENT_SUFFIXES);

export interface MarketItem {
    slug: string;
    gameRef: string; // relics: BASE path, no suffix. mods/arcanes: the real full grantable path.
    name: string;
    icon: string | null;
    category: ItemCategory;
    type: ItemType;
    defaultSubtype: string; // default warframe.market order "subtype" for this item (rank-0 mods: "regular"; relics: "intact")
    maxRank: number | null; // mods/arcanes only, null otherwise
    refinements: string[] | null; // relics only (subset of RELIC_REFINEMENT_SUFFIXES' keys), null otherwise
}

const REFRESH_MS = 60 * 60 * 1000; // 1 hour

let cache: MarketItem[] = [];
let cachedAt = 0;
let refreshing: Promise<MarketItem[]> | null = null;

function iconUrl(icon: string | undefined): string | null {
    return icon ? `https://warframe.market/static/assets/${icon}` : null;
}

function classify(item: WfmItemEntry): MarketItem | null {
    const en = item.i18n.en;
    if (!en || !item.gameRef) return null;

    // Riven placeholders are tagged "riven_mod"/"veiled_riven", NOT the
    // exact "riven" tag this used to check for - that mismatch let 7
    // "Veiled Riven Mod" items slip into the shop (confirmed 2026-09-17
    // by downloading the full catalog and checking real tag names, not
    // guessed). Rivens are excluded entirely: buying/selling a veiled
    // riven from this shop would decrement the SAME stackable ItemType a
    // player's real earned-in-game veiled rivens live in - indistinguishable,
    // so a Sell click here could silently remove a real one.
    const isRiven = item.tags.some(t => t.includes("riven"));

    if (item.tags.includes("arcane_enhancement") && !isRiven) {
        return {
            slug: item.slug,
            gameRef: item.gameRef,
            name: en.name,
            icon: iconUrl(en.icon),
            category: "Upgrades",
            type: "arcane",
            defaultSubtype: "regular",
            maxRank: item.maxRank ?? null,
            refinements: null
        };
    }

    if (item.tags.includes("mod") && !isRiven) {
        return {
            slug: item.slug,
            gameRef: item.gameRef,
            name: en.name,
            icon: iconUrl(en.icon),
            category: "Upgrades",
            type: "mod",
            defaultSubtype: "regular",
            maxRank: item.maxRank ?? null,
            refinements: null
        };
    }

    if (item.tags.includes("relic")) {
        const refinements = (item.subtypes && item.subtypes.length > 0 ? item.subtypes : DEFAULT_RELIC_REFINEMENTS).filter(
            s => s in RELIC_REFINEMENT_SUFFIXES
        );
        return {
            slug: item.slug,
            gameRef: item.gameRef,
            name: en.name,
            icon: iconUrl(en.icon),
            category: "MiscItems",
            type: "relic",
            defaultSubtype: refinements.includes("intact") ? "intact" : (refinements[0] ?? "intact"),
            maxRank: null,
            refinements
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
