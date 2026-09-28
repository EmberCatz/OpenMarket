// On-disk store for icons downloaded ONCE from the network (see
// iconDownloader.ts) so the shop can show real art fully offline afterwards.
//
// Sits between localIcons.ts (extracted from the user's own game cache -
// preferred, exact) and the remote CDN URLs in itemsCache.ts's iconUrl():
// a downloaded copy replaces the remote URL for that image, nothing else
// changes. Files live in icon-cache/downloaded/ (gitignored like the rest
// of icon-cache/, and already served by index.ts's /icon-cache static
// route), named by a hash of the SOURCE URL - several catalog items share
// one image (every refinement of a relic, for one), so keying by URL
// stores each image once and needs no mapping file: the index is rebuilt
// by listing the directory.
//
// Lookups are pure in-memory Map reads (no fs.existsSync per item - see
// itemsCache.ts's getItems() note on why per-item sync stats hurt).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bumpIconCacheVersion } from "./localIcons.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DOWNLOAD_DIR = path.join(__dirname, "../icon-cache/downloaded");

// hash -> file name (with extension), e.g. "3fa9..." -> "3fa9....jpg"
const index = new Map<string, string>();
let bytesOnDisk = 0;

export function urlHash(url: string): string {
    return crypto.createHash("sha1").update(url).digest("hex").slice(0, 24);
}

function scan(): void {
    index.clear();
    bytesOnDisk = 0;
    let names: string[];
    try {
        names = fs.readdirSync(DOWNLOAD_DIR);
    } catch {
        return; // nothing downloaded yet
    }
    for (const name of names) {
        if (name.endsWith(".tmp")) {
            // A download interrupted mid-write (server killed) - never a
            // valid image, remove it.
            try {
                fs.unlinkSync(path.join(DOWNLOAD_DIR, name));
            } catch {}
            continue;
        }
        const dot = name.lastIndexOf(".");
        if (dot <= 0) continue;
        index.set(name.slice(0, dot), name);
        try {
            bytesOnDisk += fs.statSync(path.join(DOWNLOAD_DIR, name)).size;
        } catch {}
    }
}
scan();

export function getDownloadedIconPath(remoteUrl: string): string | null {
    const file = index.get(urlHash(remoteUrl));
    return file ? `/icon-cache/downloaded/${file}` : null;
}

export function hasDownloadedIcon(remoteUrl: string): boolean {
    return index.has(urlHash(remoteUrl));
}

export function getDownloadedStats(): { count: number; bytes: number } {
    return { count: index.size, bytes: bytesOnDisk };
}

// Writes atomically (temp file, then rename) so a killed server can never
// leave a half-written image that the index would later serve as valid.
export function storeDownloadedIcon(remoteUrl: string, extension: string, data: Buffer): void {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const hash = urlHash(remoteUrl);
    const name = `${hash}.${extension}`;
    const finalPath = path.join(DOWNLOAD_DIR, name);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, finalPath);
    if (!index.has(hash)) bytesOnDisk += data.length;
    index.set(hash, name);
}

// Wipes every downloaded icon (not used by the UI yet - here so a "clear
// downloaded data" action doesn't need to know the directory layout).
export function clearDownloadedIcons(): void {
    try {
        fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
    } catch {}
    index.clear();
    bytesOnDisk = 0;
    bumpIconCacheVersion();
}
