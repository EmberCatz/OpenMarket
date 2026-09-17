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
