import { Router } from "express";
import { readFileSync } from "node:fs";
import { getItems, findItemByGameRef, findItemBySlug, resolveSellGameRef, RELIC_REFINEMENT_SUFFIXES } from "./itemsCache.js";
import { getPrice, getPriceCacheStatus, triggerManualRefresh } from "./priceCache.js";
import { enqueueOrder, popPendingOrder, reportOrderResult, getOrder } from "./orderQueue.js";
import {
    setInventorySnapshot,
    getOwnedCount,
    hasInventorySnapshot,
    setRankedInstances,
    getOwnedRanks,
    takeOidForRank,
    getTotalOwned,
    type RankedInstance
} from "./inventorySnapshot.js";

export const apiRouter = Router();
export const internalRouter = Router();

const SERVER_STARTED_AT = Date.now();

// Read once at startup, not per-request - this is what lets the launcher's
// "Check for Issues" diagnostic tell a genuinely-updated server (git pull
// done AND process restarted) apart from a stale checkout or a stale
// still-running process, neither of which git alone can detect from the
// launcher side. Bump this version (server/package.json) in lockstep with
// launcher/package.json on every release - see the release walkthrough in
// ../CLAUDE.md.
const SERVER_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;

// Set whenever Market Sync.pluto polls /internal/pending-order (see
// below) - the ONLY signal this server has that the script is alive,
// since the script always initiates contact, never the other way
// around. POLL_MS in Market Sync.pluto is 2000ms (confirmed by reading
// the dev copy in My Scripts/) - PLUTO_STALE_MS is 4x that to absorb
// normal jitter/game hitches without flapping "Connected"/"Disconnected"
// on every missed beat.
let lastPlutoPollAt: number | null = null;
const PLUTO_STALE_MS = 8000;

// --- Launcher-facing (public API - also usable directly via curl) ---

// Bump schemaVersion on any breaking shape change so a consumer (the
// OpenMarket Launcher, or anything else polling this) can detect a
// version it doesn't understand and show "unknown" rather than
// misreading a renamed/restructured field as a false status.
apiRouter.get("/status", (_req, res) => {
    res.json({
        schemaVersion: 1,
        serverVersion: SERVER_VERSION,
        server: { ok: true, uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000) },
        database: getPriceCacheStatus(),
        pluto: {
            lastPollAt: lastPlutoPollAt,
            connected: lastPlutoPollAt !== null && Date.now() - lastPlutoPollAt < PLUTO_STALE_MS
        }
    });
});

// --- Frontend-facing ---

// User-triggered "Update Prices" button - forces a full resweep instead
// of waiting for the automatic weekly one (see priceCache.ts's
// triggerManualRefresh()/runBackfillSweep() for how a NEW item's price
// normally gets backfilled automatically without needing this at all;
// this is for a user who wants genuinely current numbers for everything,
// not just gap-filling). Returns immediately - the sweep runs in the
// background, same as the automatic one, so the frontend polls
// GET /api/status's `database` field for progress/completion rather than
// waiting on this request.
apiRouter.post("/refresh-prices", (_req, res) => {
    const { started } = triggerManualRefresh();
    if (!started) {
        res.status(409).json({ error: "A price refresh is already in progress." });
        return;
    }
    res.status(202).json({ started: true });
});

apiRouter.get("/items", async (_req, res) => {
    try {
        res.json(await getItems());
    } catch (err) {
        res.status(502).json({ error: `Failed to load items from warframe.market: ${(err as Error).message}` });
    }
});

apiRouter.get("/price/:slug", async (req, res) => {
    const subtype = typeof req.query.subtype === "string" ? req.query.subtype : "regular";
    const rank = typeof req.query.rank === "string" ? parseInt(req.query.rank, 10) || 0 : 0;
    try {
        // maxRank bounds the rank-interpolation fallback (see priceCache.ts) -
        // only mods/arcanes have one, everything else passes null and just
        // skips that fallback entirely.
        const item = await findItemBySlug(req.params.slug);
        res.json(await getPrice(req.params.slug, subtype, rank, item?.maxRank ?? null));
    } catch (err) {
        res.status(502).json({ error: `Failed to load price from warframe.market: ${(err as Error).message}` });
    }
});

apiRouter.post("/order", async (req, res) => {
    const { gameRef, direction, price, rank, refinement } = req.body as {
        gameRef?: string;
        direction?: string;
        price?: number;
        rank?: number;
        refinement?: string;
    };
    if (!gameRef || (direction !== "buy" && direction !== "sell") || typeof price !== "number" || price < 0) {
        res.status(400).json({ error: "Expected { gameRef, direction: 'buy'|'sell', price, rank?, refinement? }" });
        return;
    }
    const item = await findItemByGameRef(gameRef);
    if (!item) {
        res.status(404).json({ error: "Unknown ItemType path (not in the current warframe.market items list)" });
        return;
    }

    // Prime sets are buy-only - "selling a set" isn't a real single
    // operation (see itemsCache.ts's module comment: a set's own gameRef
    // is the finished Warframe's Suit type, never granted directly).
    // Individual Prime parts can still be sold normally - this only
    // blocks selling the set-bundle entry itself.
    if (item.type === "prime_set") {
        if (direction !== "buy") {
            res.status(400).json({ error: "Selling a full Prime set isn't supported - sell individual parts instead." });
            return;
        }
        if (!item.parts || item.parts.length === 0) {
            res.status(400).json({ error: `${item.name} has no resolved parts to grant` });
            return;
        }
        const order = enqueueOrder(direction, item.gameRef, item.name, Math.round(price), item.category, 0, item.parts);
        console.log(`Order enqueued: buy ${item.name} (full set) for ${Math.round(price)}p [${order.id}]`);
        res.json({ orderId: order.id });
        return;
    }

    // Selling a SPECIFIC ranked mod/arcane copy - a completely different
    // path than the plain rank-0 sell below, since a ranked copy is a
    // unique-instance database record (no plain path+count decrement can
    // reach it). Resolves a real owned copy's oid from Market Sync.pluto's
    // last inventory sync and hands it to Market Sync.pluto directly -
    // see inventorySnapshot.ts's module comment for the full mechanism.
    if (direction === "sell" && item.type !== "relic" && typeof rank === "number" && rank > 0) {
        if (item.maxRank === null || rank > item.maxRank) {
            res.status(400).json({ error: `Invalid rank ${rank} for ${item.name} (max ${item.maxRank ?? 0})` });
            return;
        }
        const oid = takeOidForRank(item.gameRef, rank);
        if (!oid) {
            res.status(400).json({
                error: `No known rank ${rank} copy of ${item.name} to sell - it may have already been sold, or Market Sync.pluto hasn't synced inventory yet.`
            });
            return;
        }
        const order = enqueueOrder(direction, item.gameRef, `${item.name} (Rank ${rank})`, Math.round(price), item.category, rank, null, oid);
        console.log(`Order enqueued: sell ${item.name} (Rank ${rank}) for ${Math.round(price)}p [${order.id}]`);
        res.json({ orderId: order.id });
        return;
    }

    // Resolve what actually gets sent to Market Sync.pluto - it always
    // sees a fully-resolved gameRef + display name, never refinement/rank
    // logic itself.
    let finalGameRef = item.gameRef;
    let displayName = item.name;
    // Selling a PLAIN (rank-0) mod/arcane copy always targets the plain
    // rank-0 stock - the branch above already intercepted a specific-rank
    // sell request before reaching here.
    let effectiveRank = 0;

    if (item.type === "relic") {
        const chosen = typeof refinement === "string" ? refinement : item.defaultSubtype;
        const suffix = RELIC_REFINEMENT_SUFFIXES[chosen];
        if (!item.refinements || !item.refinements.includes(chosen) || !suffix) {
            res.status(400).json({ error: `Invalid refinement "${chosen}" for ${item.name}` });
            return;
        }
        finalGameRef = item.gameRef + suffix;
        displayName = `${item.name} (${chosen[0].toUpperCase()}${chosen.slice(1)})`;
    } else if (direction === "buy" && typeof rank === "number" && rank > 0) {
        if (item.maxRank === null || rank > item.maxRank) {
            res.status(400).json({ error: `Invalid rank ${rank} for ${item.name} (max ${item.maxRank ?? 0})` });
            return;
        }
        effectiveRank = rank;
    }

    const order = enqueueOrder(direction, finalGameRef, displayName, Math.round(price), item.category, effectiveRank);
    console.log(`Order enqueued: ${direction} ${displayName} for ${Math.round(price)}p [${order.id}]`);
    res.json({ orderId: order.id });
});

// Prime sets have no single "owned" count that means anything (buying one
// grants several different real parts, never the set's own gameRef - see
// itemsCache.ts) - the frontend only ever calls this for sellable items
// (individual parts, mods/arcanes at rank 0, relics at any refinement).
apiRouter.get("/owned/:slug", async (req, res) => {
    const item = await findItemBySlug(req.params.slug);
    if (!item) {
        res.status(404).json({ error: "Unknown slug" });
        return;
    }
    const refinement = typeof req.query.refinement === "string" ? req.query.refinement : undefined;
    const gameRef = resolveSellGameRef(item, refinement);
    res.json({ owned: getOwnedCount(gameRef), known: hasInventorySnapshot() });
});

// Breaks out ranked (rank > 0) owned copies by exact rank, e.g. owning a
// rank 0, rank 3, and max-rank Serration at once would otherwise all
// collapse into one ambiguous "Owned: N" (which only ever reflects the
// rank-0 RawUpgrades count anyway - ranked copies live in a completely
// separate collection). Only meaningful for mods/arcanes.
apiRouter.get("/owned-ranks/:slug", async (req, res) => {
    const item = await findItemBySlug(req.params.slug);
    if (!item) {
        res.status(404).json({ error: "Unknown slug" });
        return;
    }
    res.json({ ranks: getOwnedRanks(item.gameRef) });
});

// Bulk total-owned lookup for the "Owned"/"Not Owned" filter and "sort by
// owned" - a single request over already-in-memory data (no external
// calls), keyed by gameRef so the frontend can match it straight against
// the /api/items list it already has. Prime sets are never included
// (never meaningfully "owned" as a single unit - see getTotalOwned's
// module comment); the frontend treats a missing key as 0.
apiRouter.get("/owned-summary", async (_req, res) => {
    const items = await getItems();
    const summary: Record<string, number> = {};
    for (const item of items) {
        if (item.type === "prime_set") continue;
        const total = getTotalOwned(item);
        if (total > 0) summary[item.gameRef] = total;
    }
    res.json({ owned: summary, known: hasInventorySnapshot() });
});

apiRouter.get("/order/:id", (req, res) => {
    const order = getOrder(req.params.id);
    if (!order) {
        res.status(404).json({ error: "Unknown order id" });
        return;
    }
    res.json(order);
});

// --- Market Sync.pluto-facing only ---

internalRouter.get("/pending-order", (_req, res) => {
    // Log only the FIRST poll this run, not every one - at Market
    // Sync.pluto's 2s poll interval, logging every poll would be ~30
    // lines/minute of pure noise. This edge-triggered line is what
    // answers "did the script ever actually connect," which is the
    // thing that's otherwise invisible (see the terminal-panel gap this
    // was added to fix, 2026-09-18).
    if (lastPlutoPollAt === null) {
        console.log("Market Sync.pluto: connected (first poll received).");
    }
    lastPlutoPollAt = Date.now();
    const order = popPendingOrder();
    if (!order) {
        res.status(204).end();
        return;
    }
    res.json(order);
});

internalRouter.post("/inventory-snapshot", (req, res) => {
    const { counts, ranked } = req.body as { counts?: unknown; ranked?: unknown };
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
        res.status(400).json({ error: "Expected { counts: Record<string, number>, ranked?: Record<string, {rank,oid}[]> }" });
        return;
    }
    const isFirstSnapshot = !hasInventorySnapshot();
    setInventorySnapshot(counts as Record<string, number>);
    // Pluto's json.encode serializes an empty Lua table as "[]" (array),
    // not "{}" (object) - there's no ranked mods owned at all in that
    // case, so treat an empty array the same as an empty object rather
    // than rejecting it.
    if (ranked && typeof ranked === "object") {
        if (!Array.isArray(ranked)) {
            setRankedInstances(ranked as Record<string, RankedInstance[]>);
        } else if (ranked.length === 0) {
            setRankedInstances({});
        }
    }
    // 30s cadence (Market Sync.pluto's INVENTORY_POLL_MS) - not spammy
    // enough to need first-time-only gating like the poll log above, and
    // an ongoing "yes, still syncing" line is more useful here than a
    // one-off.
    console.log(
        `Inventory snapshot ${isFirstSnapshot ? "received (first)" : "updated"}: ${Object.keys(counts as object).length} item types.`
    );
    res.status(204).end();
});

internalRouter.post("/order-result", (req, res) => {
    const { orderId, ok, detail } = req.body as { orderId?: string; ok?: boolean; detail?: string };
    if (!orderId || typeof ok !== "boolean") {
        res.status(400).json({ error: "Expected { orderId, ok, detail? }" });
        return;
    }
    const found = reportOrderResult(orderId, ok, detail);
    if (!found) {
        res.status(404).json({ error: "Unknown order id" });
        return;
    }
    console.log(`Order ${orderId}: ${ok ? "completed" : "FAILED"}${detail ? ` - ${detail}` : ""}`);
    res.status(204).end();
});
