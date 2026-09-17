// In-memory cache of warframe.market's Mods + Arcanes, refreshed hourly.
// Both categories route through SpaceNinjaServer's identical addMods()/
// RawUpgrades mechanism server-side (confirmed from source: Arcane
// Energize's gameRef, "/Lotus/Upgrades/CosmeticEnhancers/Utility/...",
// falls under the same addItem() dispatch branch as plain mod paths), so
// buy/sell are symmetric ItemType-path operations for both, no oid
// resolution needed - unlike unique-instance gear (weapons, warframes,
// skins), which is still out of scope. warframe.market tags arcanes as
// "arcane_enhancement", not "arcane".

import { fetchAllItems, type WfmItemEntry } from "./warframeMarketApi.js";

export interface ModInfo {
    slug: string;
    gameRef: string;
    name: string;
    icon: string | null;
}

const REFRESH_MS = 60 * 60 * 1000; // 1 hour

let cache: ModInfo[] = [];
let cachedAt = 0;
let refreshing: Promise<ModInfo[]> | null = null;

function toModInfo(item: WfmItemEntry): ModInfo | null {
    const en = item.i18n.en;
    if (!en || !item.gameRef) return null;
    return {
        slug: item.slug,
        gameRef: item.gameRef,
        name: en.name,
        icon: en.icon ? `https://warframe.market/static/assets/${en.icon}` : null
    };
}

async function refresh(): Promise<ModInfo[]> {
    const all = await fetchAllItems();
    cache = all
        .filter(
            item =>
                (item.tags.includes("mod") || item.tags.includes("arcane_enhancement")) &&
                !item.tags.includes("riven")
        )
        .map(toModInfo)
        .filter((m): m is ModInfo => m !== null);
    cachedAt = Date.now();
    return cache;
}

export async function getMods(): Promise<ModInfo[]> {
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

export async function findModByGameRef(gameRef: string): Promise<ModInfo | undefined> {
    const mods = await getMods();
    return mods.find(m => m.gameRef === gameRef);
}
