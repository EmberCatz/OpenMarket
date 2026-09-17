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

// Many real orders just omit "subtype" entirely for plain items instead
// of explicitly writing "regular" - treat a missing subtype as "regular"
// so those orders still count. Every other subtype ("intact" for a relic,
// etc) still needs an exact match - a missing subtype is NOT assumed to
// mean "intact", only "regular" gets the undefined-is-fine treatment.
function subtypeMatches(orderSubtype: string | undefined, wanted: string): boolean {
    if (orderSubtype === wanted) return true;
    return wanted === "regular" && orderSubtype === undefined;
}

function computePrice(
    slug: string,
    subtype: string,
    orders: Awaited<ReturnType<typeof fetchOrdersForItem>>
): PriceInfo {
    // Lowest visible, matching-subtype (e.g. "regular" for a plain
    // unranked mod, "intact" for an unrefined relic), currently online
    // seller's asking price - the plain baseline warframe.market price for
    // what this app actually grants/removes. rank is mod-specific
    // (0 = unranked); relics have no rank field, so that half of the
    // check is a harmless no-op for them.
    const eligible = orders.filter(
        o =>
            o.type === "sell" &&
            o.visible &&
            subtypeMatches(o.subtype, subtype) &&
            (o.rank === undefined || o.rank === 0) &&
            o.user.status !== "offline"
    );
    if (eligible.length === 0) {
        // Fall back to any visible sell order of the right subtype (rank
        // filter too strict, or everyone's offline)
        const anySell = orders.filter(o => o.type === "sell" && o.visible && subtypeMatches(o.subtype, subtype));
        if (anySell.length === 0) {
            return { slug, platinum: null, sampleSize: 0 };
        }
        const min = Math.min(...anySell.map(o => o.platinum));
        return { slug, platinum: min, sampleSize: anySell.length };
    }
    const min = Math.min(...eligible.map(o => o.platinum));
    return { slug, platinum: min, sampleSize: eligible.length };
}

export async function getPrice(slug: string, subtype: string = "regular"): Promise<PriceInfo> {
    const cacheKey = `${slug}:${subtype}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) {
        return hit.info;
    }
    const existing = inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = (async () => {
        try {
            const orders = await fetchOrdersForItem(slug);
            const info = computePrice(slug, subtype, orders);
            cache.set(cacheKey, { info, at: Date.now() });
            return info;
        } finally {
            inFlight.delete(cacheKey);
        }
    })();
    inFlight.set(cacheKey, promise);
    return promise;
}
