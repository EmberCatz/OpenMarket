import { Router } from "express";
import { getItems, findItemByGameRef, findItemBySlug, resolveSellGameRef, RELIC_REFINEMENT_SUFFIXES } from "./itemsCache.js";
import { getPrice } from "./priceCache.js";
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

// --- Frontend-facing ---

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
    res.json({ orderId: order.id });
});

// Prime sets have no single "owned" count that means anything (buying one
// grants 4 different real parts, never the set's own gameRef - see
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
    res.status(204).end();
});
