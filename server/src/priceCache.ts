// Weekly, per-slug, disk-persisted price cache - replaces the old
// "live-fetch on every request, 5-minute TTL" model. That model meant
// every page load fired a fresh warframe.market call per visible row
// (throttled client-side to avoid rate-limiting, but still real load,
// real delay, and a "..." shown on every render). Prices don't move fast
// enough to justify that: fetch a slug's order book lazily on first
// request, then reuse it for CACHE_MS (1 week) before checking again.
//
// Two-layer fallback for a specific (slug, subtype, rank) that ISN'T
// currently listed:
//   1. lastKnownPrices - a price we ourselves have actually observed for
//      this EXACT combo before, at any point in the past. Never expires
//      on its own, only ever overwritten by a fresher real observation.
//      If an item has a real price this week, none for the next 6, then
//      a real price again, we show the 6-week-old one the whole time in
//      between rather than flipping to "no price" - it's a better guess
//      than nothing, and gets corrected the moment a fresh one appears.
//   2. Rank interpolation (subtype "regular" only) - if THIS exact rank
//      has never had a real price at all, linearly interpolate between
//      the nearest ranks (0..maxRank) that DO have a price (live or
//      remembered via #1), or clamp to whichever single side is known,
//      rather than assuming fixed 0/max-rank anchors always exist.
// Only after both layers come up empty does a price genuinely read as
// "no price" - meaning this exact combo has never once been observed
// listed, not just "not listed this week".

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fetchOrdersForItem, type WfmOrderEntry } from "./warframeMarketApi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, "../price-cache.json");
const CACHE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

interface SlugOrdersEntry {
    orders: WfmOrderEntry[];
    fetchedAt: number;
}

interface LastKnownPrice {
    platinum: number;
    observedAt: number;
}

interface DiskCache {
    slugOrders: Record<string, SlugOrdersEntry>;
    lastKnownPrices: Record<string, LastKnownPrice>;
}

let slugOrders: Record<string, SlugOrdersEntry> = {};
let lastKnownPrices: Record<string, LastKnownPrice> = {};

function loadFromDisk(): void {
    if (!existsSync(CACHE_FILE)) return;
    try {
        const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as DiskCache;
        slugOrders = parsed.slugOrders ?? {};
        lastKnownPrices = parsed.lastKnownPrices ?? {};
    } catch (err) {
        console.error(`Failed to load ${CACHE_FILE}, starting with an empty price cache:`, err);
    }
}
loadFromDisk();

// Debounced - a burst of lazy fetches (e.g. loading a fresh page of
// results) would otherwise trigger a disk write per item.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            const disk: DiskCache = { slugOrders, lastKnownPrices };
            writeFileSync(CACHE_FILE, JSON.stringify(disk));
        } catch (err) {
            console.error(`Failed to save ${CACHE_FILE}:`, err);
        }
    }, 2000);
}

const inFlight = new Map<string, Promise<WfmOrderEntry[]>>();

async function getOrdersForSlug(slug: string): Promise<WfmOrderEntry[]> {
    const hit = slugOrders[slug];
    if (hit && Date.now() - hit.fetchedAt < CACHE_MS) {
        return hit.orders;
    }
    const existing = inFlight.get(slug);
    if (existing) return existing;

    const promise = (async () => {
        try {
            const orders = await fetchOrdersForItem(slug);
            slugOrders[slug] = { orders, fetchedAt: Date.now() };
            scheduleSave();
            return orders;
        } finally {
            inFlight.delete(slug);
        }
    })();
    inFlight.set(slug, promise);
    return promise;
}

export interface PriceInfo {
    slug: string;
    platinum: number | null; // null only if this exact combo has NEVER been observed listed
    sampleSize: number; // 0 for a remembered/interpolated price, not a live count
    approx: boolean; // true if interpolated from neighboring ranks rather than observed directly
    stale: boolean; // true if this is a remembered price, not currently listed this week
}

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

// Lowest visible, matching-subtype-and-rank, currently online seller's
// asking price - null if nobody's currently selling exactly that.
function computeLivePrice(subtype: string, rank: number, orders: WfmOrderEntry[]): { platinum: number; sampleSize: number } | null {
    const eligible = orders.filter(
        o =>
            o.type === "sell" &&
            o.visible &&
            subtypeMatches(o.subtype, subtype) &&
            rankMatches(o.rank, rank) &&
            o.user.status !== "offline"
    );
    if (eligible.length > 0) {
        return { platinum: Math.min(...eligible.map(o => o.platinum)), sampleSize: eligible.length };
    }
    // Fall back to any visible sell order of the right subtype+rank
    // (online-only filter too strict, or everyone's offline).
    const anySell = orders.filter(
        o => o.type === "sell" && o.visible && subtypeMatches(o.subtype, subtype) && rankMatches(o.rank, rank)
    );
    return anySell.length > 0 ? { platinum: Math.min(...anySell.map(o => o.platinum)), sampleSize: anySell.length } : null;
}

// Live price if listed right now, else the last real price ever observed
// for this exact combo (never expires on its own). Opportunistically
// records a fresh live price into lastKnownPrices as a side effect.
function resolvePrice(
    key: string,
    subtype: string,
    rank: number,
    orders: WfmOrderEntry[]
): { platinum: number; sampleSize: number; stale: boolean } | null {
    const live = computeLivePrice(subtype, rank, orders);
    if (live !== null) {
        lastKnownPrices[key] = { platinum: live.platinum, observedAt: Date.now() };
        return { platinum: live.platinum, sampleSize: live.sampleSize, stale: false };
    }
    const remembered = lastKnownPrices[key];
    return remembered ? { platinum: remembered.platinum, sampleSize: 0, stale: true } : null;
}

export async function getPrice(
    slug: string,
    subtype: string = "regular",
    rank: number = 0,
    maxRank: number | null = null
): Promise<PriceInfo> {
    const orders = await getOrdersForSlug(slug);
    const key = `${slug}:${subtype}:${rank}`;

    const direct = resolvePrice(key, subtype, rank, orders);
    if (direct) {
        scheduleSave();
        return { slug, platinum: direct.platinum, sampleSize: direct.sampleSize, approx: false, stale: direct.stale };
    }

    // This exact rank has never once been listed/remembered - try
    // interpolating from whichever OTHER ranks of the same item do have
    // a live-or-remembered price. Only meaningful for the plain rank
    // ladder (mods/arcanes), not relic refinements or non-rankable items.
    if (subtype === "regular" && maxRank !== null && maxRank > 0) {
        const known: { rank: number; platinum: number }[] = [];
        for (let r = 0; r <= maxRank; r++) {
            const candidateKey = `${slug}:${subtype}:${r}`;
            const candidate = resolvePrice(candidateKey, subtype, r, orders);
            if (candidate) known.push({ rank: r, platinum: candidate.platinum });
        }
        scheduleSave();

        if (known.length > 0) {
            let lower: { rank: number; platinum: number } | null = null;
            let upper: { rank: number; platinum: number } | null = null;
            for (const k of known) {
                if (k.rank <= rank && (!lower || k.rank > lower.rank)) lower = k;
                if (k.rank >= rank && (!upper || k.rank < upper.rank)) upper = k;
            }
            let platinum: number;
            if (lower && upper && lower.rank !== upper.rank) {
                const t = (rank - lower.rank) / (upper.rank - lower.rank);
                platinum = Math.round(lower.platinum + (upper.platinum - lower.platinum) * t);
            } else {
                platinum = (lower ?? upper!).platinum;
            }
            return { slug, platinum, sampleSize: 0, approx: true, stale: false };
        }
    }

    return { slug, platinum: null, sampleSize: 0, approx: false, stale: false };
}
