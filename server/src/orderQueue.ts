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
    rank: number; // buy: grant at this rank (0 = plain RawUpgrades path, unchanged). sell always treats this as 0.
    status: OrderStatus;
    detail?: string;
    createdAt: number;
}

const orders = new Map<string, Order>();
const pendingQueue: string[] = [];

// If a script never reports back (crashed, stopped, network hiccup), don't
// leave the order stuck "processing" forever - the frontend times it out.
const STALE_PROCESSING_MS = 30_000;

export function enqueueOrder(
    direction: OrderDirection,
    gameRef: string,
    name: string,
    price: number,
    category: ItemCategory,
    rank: number = 0
): Order {
    const order: Order = {
        id: randomUUID(),
        direction,
        gameRef,
        name,
        price,
        category,
        rank,
        status: "pending",
        createdAt: Date.now()
    };
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
