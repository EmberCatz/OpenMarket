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
