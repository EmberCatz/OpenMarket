import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./App.css";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type LauncherConfig } from "./lib/config";
import {
    checkNode,
    checkServerDeps,
    fetchServerStatus,
    installPlutoScript,
    installServerDeps,
    isServerRunning,
    KNOWN_STATUS_SCHEMA_VERSION,
    startServer,
    stopServer,
    validatePlutoScriptsDir,
    validateRepoPath,
    type NodeStatus,
    type ServerStatus
} from "./lib/api";

const STATUS_POLL_MS = 2000;
const MAX_LOG_LINES = 5000;

type Chip = { label: string; tone: "ok" | "pending" | "off" | "unknown" };

function ChipView({ label, tone }: Chip) {
    return (
        <span className={`chip chip-${tone}`}>
            <span className="chip-dot" />
            {label}
        </span>
    );
}

export default function App() {
    const [config, setConfig] = useState<LauncherConfig>(DEFAULT_CONFIG);
    const [configLoaded, setConfigLoaded] = useState(false);
    const [status, setStatus] = useState<ServerStatus | null>(null);
    const [processAlive, setProcessAlive] = useState(false);
    const [statusUnknownSchema, setStatusUnknownSchema] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [tab, setTab] = useState<"dashboard" | "help">("dashboard");
    const [terminalOpen, setTerminalOpen] = useState(true);
    const [logLines, setLogLines] = useState<string[]>([]);
    const [repoPathValid, setRepoPathValid] = useState<boolean | null>(null);
    const [plutoDirValid, setPlutoDirValid] = useState<boolean | null>(null);
    const [depsReady, setDepsReady] = useState<boolean | null>(null);
    const [installing, setInstalling] = useState(false);
    const [nodeStatus, setNodeStatus] = useState<NodeStatus | null>(null);
    const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
    const [updating, setUpdating] = useState(false);

    const autoOpenPending = useRef(false);
    const logEndRef = useRef<HTMLDivElement>(null);
    const autoLaunchTried = useRef(false);

    // --- Load config once, on mount ---
    useEffect(() => {
        loadConfig().then(c => {
            setConfig(c);
            setConfigLoaded(true);
        });
    }, []);

    // --- Check for a usable system Node install once, on mount. Doesn't
    // depend on repoPath - Node either exists on this machine or it
    // doesn't, and PATH changes from installing it mid-session won't be
    // picked up without restarting the launcher anyway (Windows doesn't
    // propagate env var changes to already-running processes), so
    // there's no point re-checking on a timer. ---
    useEffect(() => {
        checkNode()
            .then(setNodeStatus)
            .catch(() => setNodeStatus({ found: false, version: null, sufficient: false }));
    }, []);

    // --- Check for an app update once on startup, in the background.
    // Silent no-op on failure (e.g. offline, or the endpoint being
    // unreachable) - this should never block or interrupt using the
    // launcher, just surface a banner if there's something newer. ---
    useEffect(() => {
        if (!configLoaded) return;
        check()
            .then(update => {
                if (update) setAvailableUpdate(update);
            })
            .catch(() => {
                /* offline or endpoint unreachable - not worth surfacing as an error */
            });
    }, [configLoaded]);

    async function handleUpdate() {
        if (!availableUpdate) return;
        setUpdating(true);
        setError(null);
        try {
            await availableUpdate.downloadAndInstall();
            // Windows: downloadAndInstall already exits the process to run
            // the installer, so this line is never reached there. Linux/
            // Mac install in place and need an explicit relaunch.
            await relaunch();
        } catch (e) {
            setUpdating(false);
            setError(`Update failed: ${String(e)}`);
        }
    }

    // --- Live server log stream ---
    useEffect(() => {
        const unlisten = listen<string>("server-log", event => {
            setLogLines(prev => {
                const next = [...prev, event.payload];
                return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
            });
        });
        return () => {
            unlisten.then(f => f());
        };
    }, []);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ block: "end" });
    }, [logLines]);

    // --- Status + process-alive polling ---
    useEffect(() => {
        if (!configLoaded) return;
        let cancelled = false;

        async function poll() {
            try {
                const alive = await isServerRunning();
                if (cancelled) return;
                setProcessAlive(alive);
            } catch {
                /* ignore - state remains as last known */
            }
            try {
                const s = await fetchServerStatus(config.port);
                if (cancelled) return;
                if (s.schemaVersion !== KNOWN_STATUS_SCHEMA_VERSION) {
                    setStatusUnknownSchema(true);
                    setStatus(null);
                    return;
                }
                setStatusUnknownSchema(false);
                setStatus(s);
                if (autoOpenPending.current && s.server.ok) {
                    autoOpenPending.current = false;
                    openUrl(`http://127.0.0.1:${config.port}/`).catch(() => {});
                }
            } catch {
                if (!cancelled) setStatus(null);
            }
        }

        poll();
        const id = setInterval(poll, STATUS_POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [configLoaded, config.port]);

    // Whether there's anything left to install before Launch makes sense.
    // An unconfigured Pluto scripts dir is NOT a reason to require
    // install - it's optional (the launcher only ever observes the
    // script, never depends on it to run the server) - only a
    // *configured-but-invalid* one counts, since that's the user having
    // pointed at the wrong folder.
    const nodeChecking = nodeStatus === null;
    const nodeMissing = nodeStatus !== null && !nodeStatus.sufficient;
    const needsInstall =
        nodeMissing ||
        !config.repoPath ||
        repoPathValid === false ||
        depsReady === false ||
        (config.plutoScriptsDir !== "" && plutoDirValid === false);
    const depsChecking = repoPathValid === true && depsReady === null;

    // --- Auto-launch on startup, once, if configured AND already fully
    // set up. Re-evaluates as the async validation/deps checks resolve
    // after mount (not just once) but the ref still guarantees it only
    // ever actually launches once. ---
    useEffect(() => {
        if (!configLoaded || autoLaunchTried.current) return;
        if (!config.autoLaunch || !config.repoPath) return;
        if (nodeChecking || repoPathValid === null || depsChecking) return; // still checking, wait for a real answer
        if (needsInstall) return; // don't auto-launch a broken/incomplete setup
        autoLaunchTried.current = true;
        handleLaunch();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [configLoaded, nodeStatus, repoPathValid, depsReady, plutoDirValid]);

    // --- Validate configured paths whenever they change ---
    useEffect(() => {
        if (!config.repoPath) {
            setRepoPathValid(null);
            return;
        }
        validateRepoPath(config.repoPath).then(setRepoPathValid).catch(() => setRepoPathValid(false));
    }, [config.repoPath]);

    useEffect(() => {
        if (!config.plutoScriptsDir) {
            setPlutoDirValid(null);
            return;
        }
        validatePlutoScriptsDir(config.plutoScriptsDir).then(setPlutoDirValid).catch(() => setPlutoDirValid(false));
    }, [config.plutoScriptsDir]);

    // --- Check whether server/'s npm deps are installed, once the repo
    // path itself checks out. Re-runs after a successful install too
    // (depsReady flips straight to true there without waiting on this
    // effect, but this keeps it honest on a later repoPath change). ---
    useEffect(() => {
        if (repoPathValid !== true) {
            setDepsReady(null);
            return;
        }
        checkServerDeps(config.repoPath).then(setDepsReady).catch(() => setDepsReady(false));
    }, [repoPathValid, config.repoPath]);

    async function handleLaunch() {
        setError(null);
        if (!config.repoPath) {
            setError("Set the OpenMarket repo path in Settings first.");
            setSettingsOpen(true);
            return;
        }
        setBusy(true);
        try {
            autoOpenPending.current = true;
            await startServer(config.repoPath, config.port);
        } catch (e) {
            autoOpenPending.current = false;
            setError(String(e));
        } finally {
            setBusy(false);
        }
    }

    async function handleInstall() {
        setError(null);
        if (nodeMissing) {
            // Nothing to do here - npm install/the server itself both
            // need a real Node install first, and there's no bundled
            // runtime (see the dedicated banner's "Open nodejs.org"
            // button instead of running anything).
            return;
        }
        if (!config.repoPath) {
            setError("Set the OpenMarket repo path in Settings first.");
            setSettingsOpen(true);
            return;
        }
        if (repoPathValid === false) {
            setError("The configured repo path doesn't have server/package.json - check it in Settings.");
            setSettingsOpen(true);
            return;
        }
        setInstalling(true);
        setTerminalOpen(true);
        try {
            if (depsReady === false) {
                await installServerDeps(config.repoPath);
                setDepsReady(true);
            }
            if (config.plutoScriptsDir && plutoDirValid === false) {
                await installPlutoScript(config.repoPath, config.plutoScriptsDir);
                setPlutoDirValid(true);
            }
        } catch (e) {
            setError(String(e));
        } finally {
            setInstalling(false);
        }
    }

    async function handleStop() {
        setBusy(true);
        setError(null);
        try {
            await stopServer();
            setStatus(null);
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    }

    async function handleRestart() {
        setBusy(true);
        setError(null);
        try {
            if (processAlive) await stopServer();
            await new Promise(r => setTimeout(r, 400));
            autoOpenPending.current = false;
            await startServer(config.repoPath, config.port);
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    }

    async function browseFolder(field: "repoPath" | "plutoScriptsDir") {
        const picked = await openDialog({ directory: true, multiple: false });
        if (typeof picked === "string") {
            setConfig(c => ({ ...c, [field]: picked }));
        }
    }

    async function persistConfig(next: LauncherConfig) {
        setConfig(next);
        await saveConfig(next);
    }

    const serverChip: Chip = status?.server.ok
        ? { label: "Running", tone: "ok" }
        : processAlive
        ? { label: "Starting...", tone: "pending" }
        : { label: "Stopped", tone: "off" };

    const dbChip: Chip = statusUnknownSchema
        ? { label: "Unknown (launcher out of date)", tone: "unknown" }
        : !status
        ? { label: "Unknown", tone: "unknown" }
        : status.database.state === "live"
        ? { label: "Connected", tone: "ok" }
        : status.database.state === "seeded"
        ? { label: "Pending (fallback data)", tone: "pending" }
        : { label: "Disconnected", tone: "off" };

    const plutoChip: Chip = !status
        ? { label: "Unknown", tone: "unknown" }
        : status.pluto.connected
        ? { label: "Connected", tone: "ok" }
        : { label: "Waiting", tone: "pending" };

    return (
        <div className="app">
            <header className="topbar">
                <span className="brand">OpenMarket Launcher</span>
                <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Settings">
                    ⚙
                </button>
            </header>

            {availableUpdate && (
                <div className="update-banner">
                    <span>
                        Update available: v{availableUpdate.version} (current: v{availableUpdate.currentVersion})
                    </span>
                    <button onClick={handleUpdate} disabled={updating}>
                        {updating ? "Updating..." : "Update & Restart"}
                    </button>
                </div>
            )}

            <div className="status-row">
                <span className="status-item">
                    <span className="status-label">Server</span>
                    <ChipView {...serverChip} />
                </span>
                <span className="status-item">
                    <span className="status-label">Database</span>
                    <ChipView {...dbChip} />
                </span>
                <span className="status-item">
                    <span className="status-label">Pluto Client</span>
                    <ChipView {...plutoChip} />
                </span>
            </div>

            <nav className="tabs">
                <button className={tab === "dashboard" ? "tab active" : "tab"} onClick={() => setTab("dashboard")}>
                    Dashboard
                </button>
                <button className={tab === "help" ? "tab active" : "tab"} onClick={() => setTab("help")}>
                    Help & Guides
                </button>
            </nav>

            <main className="content">
                {tab === "dashboard" && (
                    <div className="dashboard">
                        {error && <div className="banner error">{error}</div>}
                        {nodeMissing && (
                            <div className="banner error">
                                <div>
                                    {nodeStatus?.found
                                        ? `Node.js ${nodeStatus.version} found, but 18+ is required.`
                                        : "Node.js 18+ wasn't found on this system."}{" "}
                                    Install it, then restart this app - installing it mid-session isn't picked up
                                    automatically.
                                </div>
                                <button onClick={() => openUrl("https://nodejs.org/").catch(e => setError(String(e)))}>
                                    Open nodejs.org
                                </button>
                            </div>
                        )}
                        {!nodeMissing && !config.repoPath && (
                            <div className="banner warn">
                                No OpenMarket repo path configured yet - open Settings to point the launcher at it.
                            </div>
                        )}

                        <button
                            className="launch-btn"
                            onClick={needsInstall ? handleInstall : handleLaunch}
                            disabled={busy || processAlive || installing || depsChecking || nodeChecking || nodeMissing}
                        >
                            {processAlive
                                ? "Running"
                                : nodeChecking
                                ? "Checking..."
                                : nodeMissing
                                ? "⬇ Install"
                                : installing
                                ? "Installing..."
                                : depsChecking
                                ? "Checking..."
                                : needsInstall
                                ? "⬇ Install"
                                : "▶ Launch App"}
                        </button>
                        {needsInstall && !nodeMissing && !installing && config.repoPath && repoPathValid !== false && (
                            <div className="install-hint">
                                Will set up:{" "}
                                {[
                                    depsReady === false && "server dependencies (npm install)",
                                    config.plutoScriptsDir && plutoDirValid === false && "Market Sync.pluto in your scripts folder"
                                ]
                                    .filter(Boolean)
                                    .join(", ") || "nothing yet - set the repo path in Settings"}
                            </div>
                        )}

                        <div className="secondary-actions">
                            <button onClick={handleStop} disabled={busy || !processAlive}>
                                Stop
                            </button>
                            <button onClick={handleRestart} disabled={busy || !config.repoPath || needsInstall}>
                                Restart
                            </button>
                            <button
                                onClick={() => openUrl(`http://127.0.0.1:${config.port}/`).catch(e => setError(String(e)))}
                                disabled={!status?.server.ok}
                            >
                                Open in Browser
                            </button>
                        </div>

                        {status && (
                            <div className="status-detail">
                                <div>Uptime: {status.server.uptimeSeconds}s</div>
                                <div>Priced items: {status.database.itemCount}</div>
                                <div>
                                    Pluto last poll:{" "}
                                    {status.pluto.lastPollAt
                                        ? `${Math.round((Date.now() - status.pluto.lastPollAt) / 1000)}s ago`
                                        : "never this session"}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {tab === "help" && (
                    <div className="help">
                        <h3>Setup Guides</h3>
                        <p>Opens the README (covers backend setup, script install, and pricing) in your default viewer.</p>
                        <div className="help-links">
                            <button onClick={() => openPath(`${config.repoPath}/README.md`).catch(e => setError(String(e)))}>
                                OpenMarket README
                            </button>
                        </div>
                        <h3>Troubleshooting</h3>
                        <ul>
                            <li><strong>Server stuck on "Starting...":</strong> check the terminal panel below for a stack trace. If the button still says "Install" instead of "Launch App", run that first.</li>
                            <li><strong>Database stays "Disconnected":</strong> `price-history.seed.json` failed to load - check it exists in the repo's `server/` folder.</li>
                            <li><strong>Pluto Client never connects:</strong> the launcher only observes; you still have to start Market Sync.pluto yourself in-game. Check the Bootstrapper's script_log at http://localhost:6155/script_log for errors.</li>
                            <li><strong>Port already in use:</strong> another instance (or a manual `npm start`) is likely already bound to it - change the port in Settings or stop the other instance.</li>
                        </ul>
                    </div>
                )}
            </main>

            <div className={`terminal ${terminalOpen ? "open" : "collapsed"}`}>
                <div className="terminal-header" onClick={() => setTerminalOpen(o => !o)}>
                    <span>{terminalOpen ? "▼" : "▶"} Terminal Output</span>
                    <span className="terminal-actions">
                        <button
                            onClick={e => {
                                e.stopPropagation();
                                setLogLines([]);
                            }}
                        >
                            Clear
                        </button>
                    </span>
                </div>
                {terminalOpen && (
                    <div className="terminal-body">
                        {logLines.length === 0 ? (
                            <div className="terminal-empty">No output yet - launch the app to see server logs here.</div>
                        ) : (
                            logLines.map((line, i) => (
                                <div key={i} className={line.startsWith("[stderr]") ? "log-line err" : "log-line"}>
                                    {line}
                                </div>
                            ))
                        )}
                        <div ref={logEndRef} />
                    </div>
                )}
            </div>

            {settingsOpen && (
                <div className="drawer-backdrop" onClick={() => setSettingsOpen(false)}>
                    <div className="drawer" onClick={e => e.stopPropagation()}>
                        <div className="drawer-header">
                            <span>Settings</span>
                            <button className="icon-btn" onClick={() => setSettingsOpen(false)}>
                                ✕
                            </button>
                        </div>

                        <label className="field">
                            <span>OpenMarket repo path</span>
                            <div className="field-row">
                                <input
                                    value={config.repoPath}
                                    onChange={e => setConfig(c => ({ ...c, repoPath: e.target.value }))}
                                    onBlur={() => persistConfig(config)}
                                    placeholder=".../OpenMarket"
                                />
                                <button onClick={() => browseFolder("repoPath")}>Browse</button>
                            </div>
                            {repoPathValid === true && <span className="hint ok">✓ server/package.json found</span>}
                            {repoPathValid === false && <span className="hint bad">✗ no server/package.json here</span>}
                        </label>

                        <label className="field">
                            <span>Server port</span>
                            <input
                                type="number"
                                value={config.port}
                                onChange={e => setConfig(c => ({ ...c, port: Number(e.target.value) || DEFAULT_CONFIG.port }))}
                                onBlur={() => persistConfig(config)}
                            />
                        </label>

                        <label className="field">
                            <span>Pluto scripts directory</span>
                            <div className="field-row">
                                <input
                                    value={config.plutoScriptsDir}
                                    onChange={e => setConfig(c => ({ ...c, plutoScriptsDir: e.target.value }))}
                                    onBlur={() => persistConfig(config)}
                                    placeholder=".../OpenWF/Scripts"
                                />
                                <button onClick={() => browseFolder("plutoScriptsDir")}>Browse</button>
                            </div>
                            {plutoDirValid === true && <span className="hint ok">✓ Market Sync.pluto found</span>}
                            {plutoDirValid === false && <span className="hint bad">✗ Market Sync.pluto not found here</span>}
                        </label>

                        <label className="field checkbox">
                            <input
                                type="checkbox"
                                checked={config.autoLaunch}
                                onChange={e => persistConfig({ ...config, autoLaunch: e.target.checked })}
                            />
                            <span>Auto-launch server when the launcher opens</span>
                        </label>

                        <button className="save-btn" onClick={() => persistConfig(config)}>
                            Save
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
