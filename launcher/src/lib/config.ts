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

// --- "Launcher was just updated" notice -----------------------------------
// Updating the launcher never refreshes the item catalog, prices or icons:
// this app runs entirely off its local data and only re-downloads it when
// the user clicks "Update Data" in the OpenMarket web UI. Remembering the
// last version that ran lets the next start after an auto-update say so.
// The notice is stored (not just shown once) so closing the launcher
// before reading it doesn't lose it - it stays until dismissed.

export interface DataUpdateNotice {
    from: string;
    to: string;
}

const LAST_RUN_VERSION_KEY = "lastRunVersion";
const DATA_NOTICE_KEY = "dataUpdateNotice";

// Call once per startup with the running version. Returns the notice to
// show (a newly detected update, or one still undismissed from an earlier
// run), or null. A first-ever run just records the version - a fresh
// install isn't an "update".
export async function checkForUpdateNotice(currentVersion: string): Promise<DataUpdateNotice | null> {
    const store = await getStore();
    const last = await store.get<string>(LAST_RUN_VERSION_KEY);
    if (last !== currentVersion) {
        await store.set(LAST_RUN_VERSION_KEY, currentVersion);
        if (last) {
            const notice: DataUpdateNotice = { from: last, to: currentVersion };
            await store.set(DATA_NOTICE_KEY, notice);
            return notice;
        }
    }
    return (await store.get<DataUpdateNotice>(DATA_NOTICE_KEY)) ?? null;
}

export async function dismissUpdateNotice(): Promise<void> {
    const store = await getStore();
    await store.delete(DATA_NOTICE_KEY);
}
