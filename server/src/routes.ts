import { Router } from "express";
import { getMods, findModByGameRef } from "./modsCache.js";
import { getPrice } from "./priceCache.js";
import { enqueueOrder, popPendingOrder, reportOrderResult, getOrder } from "./orderQueue.js";

export const apiRouter = Router();
export const internalRouter = Router();

// --- Frontend-facing ---

apiRouter.get("/mods", async (_req, res) => {
    try {
        res.json(await getMods());
    } catch (err) {
        res.status(502).json({ error: `Failed to load mods from warframe.market: ${(err as Error).message}` });
    }
});

apiRouter.get("/price/:slug", async (req, res) => {
    try {
        res.json(await getPrice(req.params.slug));
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
    const mod = await findModByGameRef(gameRef);
    if (!mod) {
        res.status(404).json({ error: "Unknown mod ItemType path (not in the current warframe.market Mods list)" });
        return;
    }
    const order = enqueueOrder(direction, gameRef, mod.name, Math.round(price));
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
