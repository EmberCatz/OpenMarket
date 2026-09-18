import { invoke } from "@tauri-apps/api/core";

// Mirrors the shape published by GET /api/status in market-emulator/
// server/src/routes.ts. schemaVersion is checked by the caller before
// trusting the rest of this shape - see App.tsx's handling of an
// unrecognized version.
export interface ServerStatus {
    schemaVersion: number;
    server: { ok: boolean; uptimeSeconds: number };
    database: {
        state: "empty" | "seeded" | "live";
        lastRefreshCompletedAt: number | null;
        refreshInProgress: boolean;
        itemCount: number;
    };
    pluto: { lastPollAt: number | null; connected: boolean };
}

export const KNOWN_STATUS_SCHEMA_VERSION = 1;

export function validateRepoPath(repoPath: string): Promise<boolean> {
    return invoke("validate_repo_path", { repoPath });
}

export function validatePlutoScriptsDir(dir: string): Promise<boolean> {
    return invoke("validate_pluto_scripts_dir", { dir });
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
