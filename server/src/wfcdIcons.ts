// Second icon tier, between localIcons.ts's fully-offline extraction and
// the existing browse.wf fallback - see itemsCache.ts's iconUrl() for
// where this actually gets used.
//
// wfcd-icon-map.json (gameRef -> imageName) is generated offline by
// tools/generate-wfcd-icon-map.js from the @wfcd/items npm package
// (github.com/WFCD/warframe-items) - an actively-maintained dataset
// pulled from Warframe's own API and refreshed on every game update.
// Confirmed (2026-09-26) its `uniqueName` field is the exact same
// "/Lotus/..." string this app already uses as gameRef, so this is a
// direct key lookup, no fuzzy matching. Re-run that generator manually
// whenever @wfcd/items is bumped - this file is a static snapshot, not
// fetched live, same reasoning as icon-paths.json.
//
// https://cdn.warframestat.us/img/ is @wfcd/items' own documented image
// CDN (its README's "Image links" section) - a real, actively-maintained
// resource, not something this project is guessing at. Still just an
// opportunistic network fallback like browse.wf: the frontend's <img
// onerror> falls through to the placeholder if this CDN is unreachable,
// same as the existing browse.wf tier.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WFCD_ICON_MAP: Record<string, string> = JSON.parse(fs.readFileSync(path.join(__dirname, "../wfcd-icon-map.json"), "utf8"));

const WFCD_CDN_BASE = "https://cdn.warframestat.us/img/";

export function getWfcdIconUrl(gameRef: string): string | null {
    const imageName = WFCD_ICON_MAP[gameRef];
    return imageName ? `${WFCD_CDN_BASE}${imageName}` : null;
}
