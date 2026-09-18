import { load, type Store } from "@tauri-apps/plugin-store";

export interface LauncherConfig {
    repoPath: string;
    port: number;
    plutoScriptsDir: string;
    autoLaunch: boolean;
}

export const DEFAULT_CONFIG: LauncherConfig = {
    repoPath: "",
    port: 7890,
    plutoScriptsDir: "",
    autoLaunch: false
};

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
    // autoSave persists to disk on every set() - fine for a config this
    // small and this infrequently written (settings drawer only).
    if (!storePromise) storePromise = load("launcher-config.json", { autoSave: true });
    return storePromise;
}

export async function loadConfig(): Promise<LauncherConfig> {
    const store = await getStore();
    const saved = await store.get<LauncherConfig>("config");
    return { ...DEFAULT_CONFIG, ...saved };
}

export async function saveConfig(config: LauncherConfig): Promise<void> {
    const store = await getStore();
    await store.set("config", config);
}
