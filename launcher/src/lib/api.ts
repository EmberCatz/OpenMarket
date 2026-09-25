import { invoke } from "@tauri-apps/api/core";

// Mirrors the shape published by GET /api/status in market-emulator/
// server/src/routes.ts. schemaVersion is checked by the caller before
// trusting the rest of this shape - see App.tsx's handling of an
// unrecognized version.
//
// v2 (2026-09-25): server moved to a fully offline/manual-refresh data
// model (catalog + icons disk-cached like prices already were, no more
// automatic background refreshing) - added `catalog`/`icons`, neither
// consumed by the launcher UI yet, but the schema bump itself is
// load-bearing: an un-bumped launcher would otherwise silently show
// "unknown" status against any server running this or a later version.
export interface ServerStatus {
    schemaVersion: number;
    serverVersion?: string;
    server: { ok: boolean; uptimeSeconds: number };
    catalog: {
        state: "empty" | "seeded" | "live";
        itemCount: number;
        lastRefreshedAt: number | null;
        refreshInProgress: boolean;
    };
    database: {
        state: "empty" | "seeded" | "live";
        lastRefreshCompletedAt: number | null;
        refreshInProgress: boolean;
        itemCount: number;
    };
    icons: {
        localExtractionAvailable: boolean;
        extracting: boolean;
        totalFolders: number;
        extractedFolders: number;
    };
    pluto: { lastPollAt: number | null; connected: boolean };
}

export const KNOWN_STATUS_SCHEMA_VERSION = 2;

export function validateRepoPath(repoPath: string): Promise<boolean> {
    return invoke("validate_repo_path", { repoPath });
}

export function validatePlutoScriptsDir(dir: string): Promise<boolean> {
    return invoke("validate_pluto_scripts_dir", { dir });
}

export interface NodeStatus {
    found: boolean;
    version: string | null;
    sufficient: boolean;
}

export function checkNode(): Promise<NodeStatus> {
    return invoke("check_node");
}

export function checkServerDeps(repoPath: string): Promise<boolean> {
    return invoke("check_server_deps", { repoPath });
}

export function installServerDeps(repoPath: string): Promise<void> {
    return invoke("install_server_deps", { repoPath });
}

export function installPlutoScript(repoPath: string, scriptsDir: string): Promise<void> {
    return invoke("install_pluto_script", { repoPath, scriptsDir });
}

export function startServer(repoPath: string, port: number): Promise<void> {
    return invoke("start_server", { repoPath, port });
}

export function stopServer(): Promise<void> {
    return invoke("stop_server");
}

export function isServerRunning(): Promise<boolean> {
    return invoke("is_server_running");
}

export function fetchServerStatus(port: number): Promise<ServerStatus> {
    return invoke("fetch_server_status", { port });
}
