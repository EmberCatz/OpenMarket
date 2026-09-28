// In-memory buy/sell order queue between the frontend and Market Sync.pluto.
// No persistence - this is a personal single-account tool, and a restart
// dropping in-flight orders is an acceptable, deliberately simple failure
// mode (see ../../README.md).

import { randomUUID } from "node:crypto";
import type { ItemCategory } from "./itemsCache.js";

export type OrderDirection = "buy" | "sell";
export type OrderStatus = "pending" | "processing" | "done" | "failed";

export interface Order {
    id: string;
    direction: OrderDirection;
    gameRef: string;
    name: string;
    price: number;
    category: ItemCategory; // which Items.<category> key the sell call needs - buy ignores this
    rank: number; // buy: grant at this rank. sell: informational only when sellOid is set (see below), otherwise always 0.
    parts: { gameRef: string; category: ItemCategory }[] | null; // Prime set buy only - Market Sync.pluto loops this instead of using gameRef/category above
    sellOid: string | null; // selling a SPECIFIC ranked copy only - Market Sync.pluto sells by bare oid instead of path+count when set
    status: OrderStatus;
    detail?: string;
    createdAt: number;
}

const orders = new Map<string, Order>();
let pendingQueue: string[] = [];

// Orders used to live in `orders` forever (added pruning 2026-09-28 after a
// stress test showed unbounded growth). Finished orders only need to stay
// long enough for the frontend's status polling to see the result; anything
// older than the hard cap is dropped whatever its state - a "pending" order
// that a disconnected script never picked up for an hour is stale (running
// it much later would be a surprise), so it expires instead of lingering.
const TERMINAL_RETENTION_MS = 10 * 60_000;
const HARD_RETENTION_MS = 60 * 60_000;
const PRUNE_INTERVAL_MS = 30_000;
let lastPrunedAt = 0;

export function pruneOrders(now: number = Date.now()): number {
    lastPrunedAt = now;
    let removed = 0;
    for (const [id, order] of orders) {
        const age = now - order.createdAt;
        const terminal = order.status === "done" || order.status === "failed";
        if (age > HARD_RETENTION_MS || (terminal && age > TERMINAL_RETENTION_MS)) {
            orders.delete(id);
            removed++;
        }
    }
    if (removed > 0) pendingQueue = pendingQueue.filter(id => orders.has(id));
    return removed;
}

// If a script never reports back (crashed, stopped, network hiccup), don't
// leave the order stuck "processing" forever - the frontend times it out.
const STALE_PROCESSING_MS = 30_000;

export function enqueueOrder(
    direction: OrderDirection,
    gameRef: string,
    name: string,
    price: number,
    category: ItemCategory,
    rank: number = 0,
    parts: { gameRef: string; category: ItemCategory }[] | null = null,
    sellOid: string | null = null
): Order {
    const order: Order = {
        id: randomUUID(),
        direction,
        gameRef,
        name,
        price,
        category,
        rank,
        parts,
        sellOid,
        status: "pending",
        createdAt: Date.now()
    };
    if (Date.now() - lastPrunedAt >= PRUNE_INTERVAL_MS) pruneOrders();
    orders.set(order.id, order);
    pendingQueue.push(order.id);
    return order;
}

export function popPendingOrder(): Order | undefined {
    while (pendingQueue.length > 0) {
        const id = pendingQueue.shift()!;
        const order = orders.get(id);
        if (order && order.status === "pending") {
            order.status = "processing";
            return order;
        }
    }
    return undefined;
}

export function reportOrderResult(id: string, ok: boolean, detail?: string): boolean {
    const order = orders.get(id);
    if (!order) return false;
    order.status = ok ? "done" : "failed";
    order.detail = detail;
    return true;
}

export function getOrder(id: string): Order | undefined {
    const order = orders.get(id);
    if (
        order &&
        order.status === "processing" &&
        Date.now() - order.createdAt > STALE_PROCESSING_MS
    ) {
        order.status = "failed";
        order.detail = "Timed out waiting for Market Sync.pluto to report back - is it running?";
    }
    return order;
}
