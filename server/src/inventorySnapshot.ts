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

let counts: Record<string, number> = {};
let receivedAt: number | null = null;

export function setInventorySnapshot(newCounts: Record<string, number>): void {
    counts = newCounts;
    receivedAt = Date.now();
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

let rankedInstances: Record<string, RankedInstance[]> = {};

export function setRankedInstances(newRanked: Record<string, RankedInstance[]>): void {
    rankedInstances = newRanked;
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
