// Thin wrapper around warframe.market's public, unauthenticated v2 API.
// Confirmed live 2026-09-17 (WebFetch against api.warframe.market/v2/*):
// - GET /v2/items -> { apiVersion, data: ItemEntry[] }
// - GET /v2/orders/item/:slug -> { apiVersion, data: OrderEntry[] }
// `gameRef` on an item entry is the real client ItemType path
// (e.g. "/Lotus/Upgrades/Mods/Rifle/WeaponDamageAmountMod" for Serration) -
// no separate local mapping/cross-reference against the Public Export
// dumps is needed, warframe.market already exposes it directly.

const BASE_URL = "https://api.warframe.market/v2";

// Not the user's personal contact info - warframe.market is an unrelated
// third-party service, so this stays a generic project identifier only.
const USER_AGENT = "OpenWF-Market-Emulator/0.1 (local personal tool; not for redistribution)";

export interface WfmItemEntry {
    id: string;
    slug: string;
    gameRef: string;
    tags: string[];
    i18n: {
        en?: {
            name: string;
            icon?: string;
            thumb?: string;
        };
    };
}

export interface WfmOrderEntry {
    id: string;
    type: "buy" | "sell";
    platinum: number;
    quantity: number;
    subtype?: string;
    rank?: number;
    visible: boolean;
    user: {
        ingameName: string;
        status: "ingame" | "online" | "offline";
    };
}

async function wfmFetch<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json"
        }
    });
    if (!res.ok) {
        throw new Error(`warframe.market ${path} -> HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data: T };
    return body.data;
}

export function fetchAllItems(): Promise<WfmItemEntry[]> {
    return wfmFetch<WfmItemEntry[]>("/items");
}

export function fetchOrdersForItem(slug: string): Promise<WfmOrderEntry[]> {
    return wfmFetch<WfmOrderEntry[]>(`/orders/item/${encodeURIComponent(slug)}`);
}
