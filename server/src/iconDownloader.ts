// One-shot "download every icon" job, driven by the launcher's button
// (POST /api/download-icons) and reported through GET /api/status's
// `iconDownload` field, which the launcher already polls - so progress
// needs no new channel.
//
// What it fetches: the unique remote image URLs behind the item catalog
// (itemsCache.ts's getRemoteIconUrls - the @wfcd/items CDN, with browse.wf
// for the few it lacks). Every URL comes from this app's own catalog, never
// from a request, so there's nothing for a caller to steer it at. Icons
// already on disk are skipped, which makes a re-run a cheap "top up what
// the catalog gained since" and an interrupted run resumable.
//
// Deliberately gentle on the CDN: a handful of parallel requests, a
// timeout, two retries, a size cap. Never throws to the caller - failures
// are counted and the job carries on (the frontend's <img onerror> falls
// back to the placeholder for anything that never downloaded).

import { getRemoteIconUrls } from "./itemsCache.js";
import { bumpIconCacheVersion } from "./localIcons.js";
import { getDownloadedStats, hasDownloadedIcon, storeDownloadedIcon } from "./downloadedIcons.js";

const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const BUMP_EVERY = 50; // rebuild the served item list every N new icons, not per file

export type IconDownloadState = "idle" | "running" | "done" | "cancelled" | "error";

interface Job {
    state: IconDownloadState;
    total: number; // unique remote images in the catalog
    done: number; // processed so far: downloaded + already had + failed
    failed: number;
    startedAt: number | null;
    finishedAt: number | null;
    lastError: string | null;
}

let job: Job = { state: "idle", total: 0, done: 0, failed: 0, startedAt: null, finishedAt: null, lastError: null };
let cancelRequested = false;

export interface IconDownloadStatus extends Job {
    // Persisted state (survives restarts) - what the launcher shows when idle.
    onDisk: number;
    bytesOnDisk: number;
    catalogTotal: number;
}

export function getIconDownloadStatus(): IconDownloadStatus {
    const stats = getDownloadedStats();
    return { ...job, onDisk: stats.count, bytesOnDisk: stats.bytes, catalogTotal: getRemoteIconUrls().length };
}

export function cancelIconDownload(): boolean {
    if (job.state !== "running") return false;
    cancelRequested = true;
    return true;
}

// Maps a response's content-type to a file extension; anything that isn't
// a plain image (an HTML error page served with a 200, say) is rejected.
function extensionFor(contentType: string | null): string | null {
    const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
    switch (type) {
        case "image/png":
            return "png";
        case "image/jpeg":
        case "image/jpg":
            return "jpg";
        case "image/webp":
            return "webp";
        case "image/gif":
            return "gif";
        case "image/svg+xml":
            return "svg";
        default:
            return null;
    }
}

async function downloadOne(url: string): Promise<void> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (cancelRequested) return;
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const ext = extensionFor(res.headers.get("content-type"));
            if (!ext) throw new Error(`not an image (${res.headers.get("content-type") ?? "no content-type"})`);
            const data = Buffer.from(await res.arrayBuffer());
            if (data.length === 0) throw new Error("empty response");
            if (data.length > MAX_IMAGE_BYTES) throw new Error(`too large (${data.length} bytes)`);
            storeDownloadedIcon(url, ext, data);
            return;
        } catch (err) {
            lastErr = err;
            if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
    }
    throw lastErr;
}

// Returns false if a job is already running.
export function startIconDownload(): boolean {
    if (job.state === "running") return false;

    const urls = getRemoteIconUrls();
    job = { state: "running", total: urls.length, done: 0, failed: 0, startedAt: Date.now(), finishedAt: null, lastError: null };
    cancelRequested = false;
    console.log(`Icon download: starting (${urls.length} unique images in the catalog).`);

    void run(urls);
    return true;
}

async function run(urls: string[]): Promise<void> {
    let next = 0;
    let sinceBump = 0;

    async function worker(): Promise<void> {
        while (!cancelRequested) {
            const i = next++;
            if (i >= urls.length) return;
            const url = urls[i];
            if (hasDownloadedIcon(url)) {
                job.done++;
                continue;
            }
            try {
                await downloadOne(url);
                if (++sinceBump >= BUMP_EVERY) {
                    sinceBump = 0;
                    bumpIconCacheVersion();
                }
            } catch (err) {
                job.failed++;
                job.lastError = `${url} - ${err instanceof Error ? err.message : String(err)}`;
            }
            job.done++;
        }
    }

    try {
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
        job.state = cancelRequested ? "cancelled" : "done";
    } catch (err) {
        // A worker only throws on a bug (downloads catch their own errors).
        job.state = "error";
        job.lastError = err instanceof Error ? err.message : String(err);
    } finally {
        job.finishedAt = Date.now();
        bumpIconCacheVersion();
        const stats = getDownloadedStats();
        console.log(
            `Icon download: ${job.state} - ${job.done}/${job.total} processed, ${job.failed} failed, ${stats.count} stored (${(stats.bytes / 1048576).toFixed(1)} MB).`
        );
    }
}
