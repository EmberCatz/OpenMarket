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

function computePrice(slug: string, orders: Awaited<ReturnType<typeof fetchOrdersForItem>>): PriceInfo {
    // Lowest visible, unranked ("regular" subtype, rank 0/unset), currently
    // online seller's asking price - the plain baseline warframe.market
    // price for a freshly-acquired copy, matching v1's unranked-only scope.
    const eligible = orders.filter(
        o =>
            o.type === "sell" &&
            o.visible &&
            (o.subtype === undefined || o.subtype === "regular") &&
            (o.rank === undefined || o.rank === 0) &&
            o.user.status !== "offline"
    );
    if (eligible.length === 0) {
        // Fall back to any visible sell order (rank/subtype filter too strict, or everyone's offline)
        const anySell = orders.filter(o => o.type === "sell" && o.visible);
        if (anySell.length === 0) {
            return { slug, platinum: null, sampleSize: 0 };
        }
        const min = Math.min(...anySell.map(o => o.platinum));
        return { slug, platinum: min, sampleSize: anySell.length };
    }
    const min = Math.min(...eligible.map(o => o.platinum));
    return { slug, platinum: min, sampleSize: eligible.length };
}

export async function getPrice(slug: string): Promise<PriceInfo> {
    const hit = cache.get(slug);
    if (hit && Date.now() - hit.at < CACHE_MS) {
        return hit.info;
    }
    const existing = inFlight.get(slug);
    if (existing) return existing;

    const promise = (async () => {
        try {
            const orders = await fetchOrdersForItem(slug);
            const info = computePrice(slug, orders);
            cache.set(slug, { info, at: Date.now() });
            return info;
        } finally {
            inFlight.delete(slug);
        }
    })();
    inFlight.set(slug, promise);
    return promise;
}
