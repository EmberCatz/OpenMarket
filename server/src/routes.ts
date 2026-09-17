import { Router } from "express";
import { getItems, findItemByGameRef, RELIC_REFINEMENT_SUFFIXES } from "./itemsCache.js";
import { getPrice } from "./priceCache.js";
import { enqueueOrder, popPendingOrder, reportOrderResult, getOrder } from "./orderQueue.js";

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
        res.json(await getPrice(req.params.slug, subtype, rank));
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

    // Resolve what actually gets sent to Market Sync.pluto - it always
    // sees a fully-resolved gameRef + display name, never refinement/rank
    // logic itself.
    let finalGameRef = item.gameRef;
    let displayName = item.name;
    // Selling a specific RANKED mod/arcane copy isn't supported yet (would
    // need /api/inventory.php-based oid resolution) - sell always targets
    // the plain rank-0 stock regardless of what rank was requested/shown.
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
