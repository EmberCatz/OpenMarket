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
    maxRank?: number; // present on mods/arcanes, absent on relics/other non-rankable items
    subtypes?: string[]; // present on relics ("intact"/"exceptional"/"flawless"/"radiant"), absent otherwise
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

// One daily aggregate, already computed by warframe.market itself from
// real closed trades - not something this app derives from raw orders.
// mod_rank/subtype distinguish which variant a given day's numbers are
// for (mods/arcanes use mod_rank, relics use subtype); an item with
// neither (Prime parts) has one series with both fields absent.
export interface WfmStatisticsEntry {
    datetime: string;
    volume: number;
    median: number;
    mod_rank?: number;
    subtype?: string;
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

// The LEGACY v1 API - v2 has no equivalent endpoint at all (checked, not
// guessed: /v2/item/:slug/statistics, /v2/items/:slug/statistics, and
// /v2/statistics/:slug all 404). This is the only source of real
// historical price data this app can get - confirmed still live
// 2026-09-18 - but it's v1, unlike everything else this app calls, so
// it's not guaranteed to keep working the way v2 is. A single call here
// covers EVERY rank/refinement of an item's whole 90-day history at
// once, unlike the per-rank live order calls elsewhere in this app.
const V1_BASE_URL = "https://api.warframe.market/v1";

// Carries the real HTTP status so callers can special-case 429 (this
// endpoint rate-limits on CONCURRENT requests specifically - see
// priceCache.ts's module comment) without parsing an error message string.
export class WfmHttpError extends Error {
    constructor(
        message: string,
        public readonly status: number
    ) {
        super(message);
    }
}

export async function fetchStatistics90Days(slug: string): Promise<WfmStatisticsEntry[]> {
    const res = await fetch(`${V1_BASE_URL}/items/${encodeURIComponent(slug)}/statistics`, {
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json"
        }
    });
    if (!res.ok) {
        throw new WfmHttpError(`warframe.market v1 statistics ${slug} -> HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as { payload?: { statistics_closed?: { "90days"?: WfmStatisticsEntry[] } } };
    return body.payload?.statistics_closed?.["90days"] ?? [];
}
