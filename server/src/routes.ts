import { Router } from "express";
import { getItems, findItemByGameRef } from "./itemsCache.js";
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
    try {
        res.json(await getPrice(req.params.slug, subtype));
    } catch (err) {
        res.status(502).json({ error: `Failed to load price from warframe.market: ${(err as Error).message}` });
    }
});

apiRouter.post("/order", async (req, res) => {
    const { gameRef, direction, price } = req.body as { gameRef?: string; direction?: string; price?: number };
    if (!gameRef || (direction !== "buy" && direction !== "sell") || typeof price !== "number" || price < 0) {
        res.status(400).json({ error: "Expected { gameRef, direction: 'buy'|'sell', price }" });
        return;
    }
    const item = await findItemByGameRef(gameRef);
    if (!item) {
        res.status(404).json({ error: "Unknown ItemType path (not in the current warframe.market items list)" });
        return;
    }
    const order = enqueueOrder(direction, gameRef, item.name, Math.round(price), item.category);
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
