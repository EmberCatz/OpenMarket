// Per-slug price cache, 5 minutes, so repeated frontend polling doesn't
// hammer warframe.market's public API.

import { fetchOrdersForItem } from "./warframeMarketApi.js";

const CACHE_MS = 5 * 60 * 1000;

export interface PriceInfo {
    slug: string;
    platinum: number | null; // null if no eligible sell orders found
    sampleSize: number;
}

const cache = new Map<string, { info: PriceInfo; at: number }>();
const inFlight = new Map<string, Promise<PriceInfo>>();

// Many real orders just omit "subtype"/"rank" entirely for the plain/
// unranked baseline instead of writing it explicitly - treat a missing
// value as a match for the DEFAULT case only ("regular" subtype, rank 0).
// Any other requested value still needs an exact match - a missing field
// is never assumed to mean "intact" or "rank 5", only the baseline.
function subtypeMatches(orderSubtype: string | undefined, wanted: string): boolean {
    if (orderSubtype === wanted) return true;
    return wanted === "regular" && orderSubtype === undefined;
}

function rankMatches(orderRank: number | undefined, wanted: number): boolean {
    if (orderRank === wanted) return true;
    return wanted === 0 && orderRank === undefined;
}

function computePrice(
    slug: string,
    subtype: string,
    rank: number,
    orders: Awaited<ReturnType<typeof fetchOrdersForItem>>
): PriceInfo {
    // Lowest visible, matching-subtype-and-rank, currently online seller's
    // asking price - the plain baseline warframe.market price for exactly
    // what this app would grant/remove at that rank.
    const eligible = orders.filter(
        o =>
            o.type === "sell" &&
            o.visible &&
            subtypeMatches(o.subtype, subtype) &&
            rankMatches(o.rank, rank) &&
            o.user.status !== "offline"
    );
    if (eligible.length === 0) {
        // Fall back to any visible sell order of the right subtype+rank
        // (online-only filter too strict, or everyone's offline)
        const anySell = orders.filter(
            o => o.type === "sell" && o.visible && subtypeMatches(o.subtype, subtype) && rankMatches(o.rank, rank)
        );
        if (anySell.length === 0) {
            return { slug, platinum: null, sampleSize: 0 };
        }
        const min = Math.min(...anySell.map(o => o.platinum));
        return { slug, platinum: min, sampleSize: anySell.length };
    }
    const min = Math.min(...eligible.map(o => o.platinum));
    return { slug, platinum: min, sampleSize: eligible.length };
}

export async function getPrice(slug: string, subtype: string = "regular", rank: number = 0): Promise<PriceInfo> {
    const cacheKey = `${slug}:${subtype}:${rank}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) {
        return hit.info;
    }
    const existing = inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = (async () => {
        try {
            const orders = await fetchOrdersForItem(slug);
            const info = computePrice(slug, subtype, rank, orders);
            cache.set(cacheKey, { info, at: Date.now() });
            return info;
        } finally {
            inFlight.delete(cacheKey);
        }
    })();
    inFlight.set(cacheKey, promise);
    return promise;
}
