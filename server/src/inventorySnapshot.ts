// In-memory snapshot of what's actually owned right now, keyed by real
// ItemType path - reported periodically by Market Sync.pluto (the only
// piece with a live SpaceNinjaServer session) from GET /api/inventory.php's
// RawUpgrades/MiscItems/Recipes arrays. Same "backend has no game session,
// script pushes it what it needs" pattern as the order queue - see
// orderQueue.ts and README.md's Architecture section.
//
// Purely a display/UX aid (owned count + graying out Sell at 0) - NOT a
// safety mechanism. SpaceNinjaServer's own sellController.ts already
// throws if a sell would take a count negative (confirmed from source:
// addMiscItems/addRecipes/addMods all guard this identically), so a
// stale/missing snapshot can at worst let a doomed Sell click through to
// a normal failed-order toast, never actually oversell anything.

import { RELIC_REFINEMENT_SUFFIXES, type MarketItem } from "./itemsCache.js";

// Null-prototype maps: keys come straight from a POST body, and a plain
// {} would let a key like "__proto__" or "constructor" resolve to
// Object.prototype members instead of "not owned".
let counts: Record<string, number> = Object.create(null);
let receivedAt: number | null = null;

// The snapshot POST is only shape-checked at the top level in routes.ts, so
// everything below it is untrusted (added 2026-09-28 after a stress test
// showed a single malformed `ranked` value crashed the whole server, and
// string counts flowed straight through to the UI). Anything that isn't a
// plain finite, non-negative, safe-integer-range number is dropped rather
// than coerced - Market Sync.pluto only ever sends real ItemCounts, so a
// bad entry means a script bug or a stray local client, and "not owned" is
// the safe reading. Returns how many entries were dropped so the caller can
// log it.
export function setInventorySnapshot(newCounts: Record<string, unknown>): { kept: number; dropped: number } {
    const clean: Record<string, number> = Object.create(null);
    let dropped = 0;
    for (const [key, value] of Object.entries(newCounts)) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
            clean[key] = value;
        } else {
            dropped++;
        }
    }
    counts = clean;
    receivedAt = Date.now();
    return { kept: Object.keys(clean).length, dropped };
}

export function getOwnedCount(gameRef: string): number {
    return counts[gameRef] ?? 0;
}

// false until Market Sync.pluto has reported at least once (script not
// running yet, or its first inventory fetch hasn't landed) - lets the
// frontend show "unknown" instead of a misleading "0 owned".
export function hasInventorySnapshot(): boolean {
    return receivedAt !== null;
}

// Ranked (rank > 0) mod/arcane copies - these live in inventory.php's
// separate "Upgrades" collection (unique-instance, one entry per owned
// copy with its own real database id), not the plain stackable
// RawUpgrades count above. Reported by Market Sync.pluto alongside the
// flat counts, parsed from each entry's UpgradeFingerprint (the same
// {"lvl":N} shape this app sends on a ranked grant - confirmed from
// SpaceNinjaServer's addItemsController.ts/inventoryService.ts, the
// request's "Fingerprint" field is stored as "UpgradeFingerprint") and
// ItemId (the instance's real oid, needed to sell that exact copy - see
// resolveSellGameRef's module comment in itemsCache.ts for why a plain
// path+count sell can't reach these).
export interface RankedInstance {
    rank: number;
    oid: string;
}

let rankedInstances: Record<string, RankedInstance[]> = Object.create(null);

// Same untrusted-input rule as setInventorySnapshot: each value must be an
// array of { rank: non-negative integer, oid: non-empty string } entries.
// Bad entries are dropped individually (one bad copy shouldn't hide the
// rest of that mod's copies); a key with no valid entries is omitted.
export function setRankedInstances(newRanked: Record<string, unknown>): { kept: number; dropped: number } {
    const clean: Record<string, RankedInstance[]> = Object.create(null);
    let kept = 0;
    let dropped = 0;
    for (const [gameRef, list] of Object.entries(newRanked)) {
        if (!Array.isArray(list)) {
            dropped++;
            continue;
        }
        const valid: RankedInstance[] = [];
        for (const entry of list) {
            const rank = (entry as { rank?: unknown } | null)?.rank;
            const oid = (entry as { oid?: unknown } | null)?.oid;
            if (typeof rank === "number" && Number.isInteger(rank) && rank >= 0 && rank <= 1000 && typeof oid === "string" && oid.length > 0) {
                valid.push({ rank, oid });
                kept++;
            } else {
                dropped++;
            }
        }
        if (valid.length > 0) clean[gameRef] = valid;
    }
    rankedInstances = clean;
    return { kept, dropped };
}

export function getOwnedRanks(gameRef: string): { rank: number; count: number }[] {
    const counted = new Map<number, number>();
    for (const { rank } of rankedInstances[gameRef] ?? []) {
        counted.set(rank, (counted.get(rank) ?? 0) + 1);
    }
    return [...counted.entries()].map(([rank, count]) => ({ rank, count })).sort((a, b) => a.rank - b.rank);
}

// Removes and returns one instance's oid for the given rank, so two rapid
// sell clicks can't both grab the same real copy before the next real
// inventory sync (~30s) would have caught the discrepancy anyway. Returns
// null if none are known at that rank - the caller should treat this as
// "nothing to sell", not silently fall back to a different rank.
export function takeOidForRank(gameRef: string, rank: number): string | null {
    const list = rankedInstances[gameRef];
    if (!list) return null;
    const idx = list.findIndex(x => x.rank === rank);
    if (idx === -1) return null;
    const [taken] = list.splice(idx, 1);
    return taken.oid;
}

export function getRankedInstanceCount(gameRef: string): number {
    return rankedInstances[gameRef]?.length ?? 0;
}

// Total owned across every variant of an item - used for the bulk
// "Owned"/"Not Owned" filter and "sort by owned" (see routes.ts's
// /api/owned-summary), where a single number per item is needed rather
// than the per-rank/per-refinement breakdown the other functions here
// give. Mods/arcanes: rank-0 stack + every ranked instance, any rank.
// Relics: summed across all 4 refinements (each a distinct real path).
// Prime parts: their own plain count. Prime sets aren't meaningfully
// "ownable" as a single unit (buying one grants 4 different real parts,
// never the set's own path - see itemsCache.ts) - always 0.
export function getTotalOwned(item: MarketItem): number {
    if (item.type === "relic") {
        return Object.values(RELIC_REFINEMENT_SUFFIXES).reduce((sum, suffix) => sum + getOwnedCount(item.gameRef + suffix), 0);
    }
    if (item.type === "mod" || item.type === "arcane") {
        return getOwnedCount(item.gameRef) + getRankedInstanceCount(item.gameRef);
    }
    if (item.type === "prime_part") {
        return getOwnedCount(item.gameRef);
    }
    return 0;
}
