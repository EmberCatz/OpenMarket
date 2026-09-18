// Weekly historical-median price cache, sourced from warframe.market's
// LEGACY v1 statistics endpoint (see warframeMarketApi.ts's
// fetchStatistics90Days - v2 has no equivalent, checked not guessed).
// Replaces the previous live-order-book model entirely: instead of
// fetching current listings on demand and falling back to a remembered
// price when nothing's currently for sale, this pre-computes ONE number
// per (item, rank/refinement) - the median of that variant's last-90-days
// daily median prices (each day's median already computed by
// warframe.market from real closed trades, not derived here) - via a
// background sweep over the whole catalog, refreshed weekly. Serving a
// price is then a synchronous in-memory lookup with ZERO network calls
// at request time, eliminating the "prices load slowly" problem at its
// root rather than just caching around it.
//
// Ladder interpolation (mod/arcane rank, AND relic refinement as of
// 2026-09-18) is carried over from the previous design, unchanged in
// spirit - if a specific rank/refinement genuinely has no trade history
// in the last 90 days, linearly interpolate between neighboring ladder
// positions that do (or clamp to the nearest single one), rather than
// assuming fixed first/last anchors exist.
//
// One real cost of this whole design: it depends on a v1 endpoint that
// could be deprecated at any time (unlike v2, which is the actively
// maintained API) - there's no fallback if warframe.market ever removes
// it. Confirmed still live 2026-09-18; if it ever starts 404ing, every
// slug's refresh just fails and keeps serving whatever the last
// successful sweep found (see refreshOneSlug), so a removal would show
// up as prices gradually going stale/missing over following weeks, not
// a sudden break.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fetchStatistics90Days, WfmHttpError, type WfmStatisticsEntry } from "./warframeMarketApi.js";
import { getItems } from "./itemsCache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, "../price-history.json");
// Committed to the repo (unlike price-history.json, which is gitignored
// runtime output) - a real, verified snapshot from a completed sweep,
// bundled so a fresh clone/install has real prices immediately instead
// of nothing for the ~6-8 minutes the first live sweep takes, AND so
// there's a clean known-good dataset to fall back to if the v1 endpoint
// this whole feature depends on ever disappears for good (see this
// file's top comment). Only ever read once, at startup, when no local
// price-history.json exists yet - never overwrites a real cache.
const SEED_FILE = path.join(__dirname, "../price-history.seed.json");
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly

// MEASURED, not assumed: 5 CONCURRENT requests against this v1 endpoint
// triggered near-immediate 429s (confirmed live 2026-09-18 - almost every
// request failed within the first few seconds of a real sweep attempt).
// Fully SEQUENTIAL requests (one in flight at a time) did not - 190/190
// succeeded across three separate test runs, including a zero-artificial-
// delay run where natural network round-trip time alone paced it to
// ~5-6/sec. This looks like a concurrent-connections limit rather than a
// requests-per-second one, so the fix is "never overlap calls" plus a
// small safety-margin delay, not a slower rate as such. At this pace, a
// full ~2500-item sweep takes roughly 7-8 minutes, not the 1-2 a naive
// concurrency-5 estimate would suggest.
const REQUEST_DELAY_MS = 150;
const RATE_LIMIT_RETRY_DELAYS_MS = [2000, 5000, 10000];

// slug -> variant key -> median platinum for that variant over the last
// 90 days. Variant key is "rank:<N>" for mods/arcanes, "subtype:<name>"
// for relics, or "default" for anything with neither (Prime parts/sets).
let priceHistory: Record<string, Record<string, number>> = {};
let lastRefreshCompletedAt: number | null = null;
let refreshInProgress = false;

interface DiskCache {
    priceHistory: Record<string, Record<string, number>>;
    lastRefreshCompletedAt: number | null;
}

function loadFromDisk(): void {
    if (existsSync(HISTORY_FILE)) {
        try {
            const parsed = JSON.parse(readFileSync(HISTORY_FILE, "utf8")) as DiskCache;
            priceHistory = parsed.priceHistory ?? {};
            lastRefreshCompletedAt = parsed.lastRefreshCompletedAt ?? null;
            return;
        } catch (err) {
            console.error(`Failed to load ${HISTORY_FILE}, starting empty:`, err);
        }
    }

    // No local cache yet (fresh install, or the file failed to parse) -
    // seed from the bundled snapshot so prices are available immediately.
    // lastRefreshCompletedAt is deliberately left null so the normal
    // staleness check (ensureFreshPriceHistory, called right after this)
    // still kicks off a real sweep on top of it - the seed is a starting
    // point to upgrade from, not treated as already-fresh data.
    if (existsSync(SEED_FILE)) {
        try {
            const parsed = JSON.parse(readFileSync(SEED_FILE, "utf8")) as { priceHistory?: Record<string, Record<string, number>> };
            priceHistory = parsed.priceHistory ?? {};
            console.log("Price history: no local cache found - seeded from the bundled snapshot, refreshing live in the background.");
        } catch (err) {
            console.error(`Failed to load bundled seed ${SEED_FILE}:`, err);
        }
    }
}
loadFromDisk();

function saveToDisk(): void {
    try {
        const disk: DiskCache = { priceHistory, lastRefreshCompletedAt };
        writeFileSync(HISTORY_FILE, JSON.stringify(disk));
    } catch (err) {
        console.error(`Failed to save ${HISTORY_FILE}:`, err);
    }
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function variantKey(entry: WfmStatisticsEntry): string {
    if (typeof entry.mod_rank === "number") return `rank:${entry.mod_rank}`;
    if (typeof entry.subtype === "string") return `subtype:${entry.subtype}`;
    return "default";
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// A 429 here gets its own retry-with-backoff (distinct from just logging
// and moving on) since it means the sweep itself briefly exceeded the
// concurrent-request limit - worth a real second attempt rather than
// silently leaving that one slug stale for a week. Any OTHER failure
// (network hiccup, a slug warframe.market doesn't recognize) isn't
// retried - it'll be tried again on the next weekly sweep regardless.
async function refreshOneSlug(slug: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            const entries = await fetchStatistics90Days(slug);
            const grouped = new Map<string, number[]>();
            for (const e of entries) {
                const key = variantKey(e);
                if (!grouped.has(key)) grouped.set(key, []);
                grouped.get(key)!.push(e.median);
            }
            const perVariant: Record<string, number> = {};
            for (const [key, medians] of grouped) {
                perVariant[key] = Math.round(median(medians));
            }
            priceHistory[slug] = perVariant;
            return;
        } catch (err) {
            const isRateLimit = err instanceof WfmHttpError && err.status === 429;
            if (isRateLimit && attempt < RATE_LIMIT_RETRY_DELAYS_MS.length) {
                await sleep(RATE_LIMIT_RETRY_DELAYS_MS[attempt]);
                continue;
            }
            // Leave whatever was there before (if anything) rather than
            // wiping a slug's history over this failure - the next
            // weekly sweep tries again from scratch.
            console.error(`Price history: failed to refresh "${slug}":`, (err as Error).message);
            return;
        }
    }
}

// Runs a full sweep over the current catalog, ONE slug at a time - see
// REQUEST_DELAY_MS's comment for why this is sequential rather than
// concurrent. Not awaited by anything request-facing. Saves to disk once
// at the end rather than per-slug: a partial/interrupted sweep still
// leaves the previous week's (still-reasonable) data in place for
// whatever hadn't been reached yet, and ~2500 individual disk writes
// would be wasteful.
async function runRefreshSweep(): Promise<void> {
    if (refreshInProgress) return;
    refreshInProgress = true;
    try {
        const items = await getItems();
        const slugs = [...new Set(items.map(i => i.slug))];
        console.log(`Price history: starting a refresh sweep over ${slugs.length} items (roughly ${Math.round((slugs.length * REQUEST_DELAY_MS) / 60000)} minutes at this pace)...`);

        for (const slug of slugs) {
            await refreshOneSlug(slug);
            await sleep(REQUEST_DELAY_MS);
        }

        lastRefreshCompletedAt = Date.now();
        saveToDisk();
        console.log(`Price history: refresh sweep complete (${slugs.length} items).`);
    } finally {
        refreshInProgress = false;
    }
}

export function ensureFreshPriceHistory(): void {
    if (lastRefreshCompletedAt === null || Date.now() - lastRefreshCompletedAt > REFRESH_INTERVAL_MS) {
        void runRefreshSweep();
    }
}

// Only ensureFreshPriceHistory() at module load checks staleness, and
// that's only evaluated once at server startup - this catches the case
// where the server stays running for more than a week straight without
// a restart.
setInterval(ensureFreshPriceHistory, 60 * 60 * 1000); // hourly check
ensureFreshPriceHistory();

export interface PriceInfo {
    slug: string;
    platinum: number | null;
    sampleSize: number; // always 0 - kept for API shape compatibility, not a meaningful live order count anymore
    approx: boolean; // true if interpolated from neighboring ladder positions rather than having its own 90-day trade history
}

// Relic refinements form the same kind of ordered "ladder" mod rank does
// (Intact cheapest/most common, Radiant priciest/rarest, Exceptional and
// Flawless in between) even though the steps are named instead of
// numbered - so the identical interpolation approach applies: a
// refinement with no 90-day trade history interpolates between
// neighboring refinements that do, rather than reading "no price" just
// because that ONE specific refinement happens to be thin. Fixed
// 2026-09-18 after being reported as a real gap - relics were the only
// item type with no fallback at all when their exact variant had no
// trade history, unlike mods/arcanes.
const RELIC_REFINEMENT_ORDER = ["intact", "exceptional", "flawless", "radiant"];

// Shared by both the mod/arcane rank ladder and the relic refinement
// ladder - `ladderKeys` is the full ordered list of variant keys for
// this item's ladder (e.g. ["rank:0", ..., "rank:10"] or
// ["subtype:intact", ..., "subtype:radiant"]), `targetIndex` is which
// position in that list is actually wanted. Never assumes the first/last
// position specifically has data - uses whatever's actually known.
function interpolateLadder(perVariant: Record<string, number>, ladderKeys: string[], targetIndex: number): number | null {
    const known: { index: number; platinum: number }[] = [];
    ladderKeys.forEach((key, index) => {
        if (perVariant[key] != null) known.push({ index, platinum: perVariant[key] });
    });
    if (known.length === 0) return null;

    let lower: { index: number; platinum: number } | null = null;
    let upper: { index: number; platinum: number } | null = null;
    for (const k of known) {
        if (k.index <= targetIndex && (!lower || k.index > lower.index)) lower = k;
        if (k.index >= targetIndex && (!upper || k.index < upper.index)) upper = k;
    }
    if (lower && upper && lower.index !== upper.index) {
        const t = (targetIndex - lower.index) / (upper.index - lower.index);
        return Math.round(lower.platinum + (upper.platinum - lower.platinum) * t);
    }
    return (lower ?? upper)!.platinum;
}

// Synchronous - no network call happens here at all, only a plain object
// lookup against whatever the last completed sweep found.
export function getPrice(slug: string, subtype: string = "regular", rank: number = 0, maxRank: number | null = null): PriceInfo {
    const perVariant = priceHistory[slug];
    if (!perVariant) {
        return { slug, platinum: null, sampleSize: 0, approx: false };
    }

    const isRankLadder = subtype === "regular" && maxRank !== null && maxRank > 0;
    const isRefinementLadder = subtype !== "regular" && RELIC_REFINEMENT_ORDER.includes(subtype);
    const key = isRefinementLadder ? `subtype:${subtype}` : isRankLadder ? `rank:${rank}` : "default";

    if (perVariant[key] != null) {
        return { slug, platinum: perVariant[key], sampleSize: 0, approx: false };
    }

    if (isRankLadder) {
        const ladderKeys = Array.from({ length: maxRank + 1 }, (_, r) => `rank:${r}`);
        const platinum = interpolateLadder(perVariant, ladderKeys, rank);
        if (platinum !== null) return { slug, platinum, sampleSize: 0, approx: true };
    }

    if (isRefinementLadder) {
        const ladderKeys = RELIC_REFINEMENT_ORDER.map(s => `subtype:${s}`);
        const platinum = interpolateLadder(perVariant, ladderKeys, RELIC_REFINEMENT_ORDER.indexOf(subtype));
        if (platinum !== null) return { slug, platinum, sampleSize: 0, approx: true };
    }

    return { slug, platinum: null, sampleSize: 0, approx: false };
}
