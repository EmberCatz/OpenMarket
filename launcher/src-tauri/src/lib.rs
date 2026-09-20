use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

// Holds the child process for the OpenMarket backend the launcher is
// currently supervising, if any. Spawns `node <server>/node_modules/
// tsx/dist/cli.mjs src/index.ts` directly rather than `npm start` -
// `npm` on Windows is a .cmd wrapper that spawns node.exe as a further
// child, so killing the top process can orphan the real server process
// (confirmed while testing this - see the launcher build notes).
// Invoking tsx's own JS entry point directly means there's exactly one
// process, and Child::kill() below terminates the real thing.
struct ServerProcess(Arc<Mutex<Option<Child>>>);

#[derive(serde::Serialize)]
struct NodeStatus {
    found: bool,
    version: Option<String>,
    sufficient: bool,
}

// The launcher relies on a system Node install (>= 18, matching the
// server's own requirement) for both `npm install` and running the
// server itself - there's no bundled/private runtime (that's a real,
// separate feature, not built yet - see DEVLOG.md). This just detects
// what's there so the UI can point the user at nodejs.org instead of
// failing confusingly partway through Install.
#[tauri::command]
async fn check_node() -> Result<NodeStatus, String> {
    let mut cmd = Command::new("node");
    cmd.arg("--version").stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = match cmd.output().await {
        Ok(o) => o,
        Err(_) => return Ok(NodeStatus { found: false, version: None, sufficient: false }),
    };
    if !output.status.success() {
        return Ok(NodeStatus { found: false, version: None, sufficient: false });
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let major: Option<u32> = raw.trim_start_matches('v').split('.').next().and_then(|s| s.parse().ok());
    let sufficient = major.map(|m| m >= 18).unwrap_or(false);
    Ok(NodeStatus { found: true, version: Some(raw), sufficient })
}

#[tauri::command]
async fn validate_repo_path(repo_path: String) -> Result<bool, String> {
    Ok(PathBuf::from(&repo_path).join("server").join("package.json").exists())
}

#[tauri::command]
async fn validate_pluto_scripts_dir(dir: String) -> Result<bool, String> {
    Ok(PathBuf::from(&dir).join("Market Sync.pluto").exists())
}

fn tsx_entry_path(repo_path: &str) -> PathBuf {
    PathBuf::from(repo_path)
        .join("server")
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("cli.mjs")
}

// Whether `server/`'s npm dependencies are installed - specifically
// whether tsx (what start_server actually invokes) is present, not just
// whether node_modules/ exists at all.
#[tauri::command]
async fn check_server_deps(repo_path: String) -> Result<bool, String> {
    Ok(tsx_entry_path(&repo_path).exists())
}

// `Command::new("npm")` fails outright on Windows with "program not
// found" - confirmed live (2026-09-19, a real user hit this, not a
// theoretical concern), not just a style preference like the tsx case
// below. npm ships as npm.cmd there, a batch file, and Rust's Command
// can't execute a batch file directly the way it can a real .exe (the
// same underlying class of problem tsx_entry_path/start_server already
// route around - this one was just missed originally, since testing
// this session's install flow went through a Bash-invoked `npm install`
// as a proxy, which uses a completely different execution path than
// Rust's Command and never actually exercised this).
//
// This is Windows-only. On Unix, `npm`'s shim is a real executable
// (shebang script or symlink to one) that the kernel dispatches
// directly, so `Command::new("npm")` already works there - confirmed
// live (2026-09-20) that trying to reuse this resolver unconditionally
// broke Homebrew/Linuxbrew installs instead, since npm ends up at
// `<brew prefix>/lib/node_modules/npm/bin/npm-cli.js`, which has no
// fixed relative path to the node binary's own (often Cellar-nested)
// directory. Guessing another relative layout would just break the
// next package manager (nvm/volta/fnm/apt all differ too) - letting
// $PATH resolve `npm` the same way it already resolves `node` is the
// only reliable answer on Unix.
//
// Fix: ask the system node for its own process.execPath (node.exe is a
// real executable, this part works fine), then invoke npm's own JS CLI
// entry directly through it - confirmed to exist at
// <node_dir>/node_modules/npm/bin/npm-cli.js next to the Node.js
// installer's node.exe on Windows (the only layout this needs to
// handle, now that Unix goes through Command::new("npm") directly).
#[cfg(target_os = "windows")]
async fn resolve_npm_cli_js() -> Result<(PathBuf, PathBuf), String> {
    let mut cmd = Command::new("node");
    cmd.args(["-e", "console.log(process.execPath)"]).stdout(Stdio::piped()).stderr(Stdio::piped());
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().await.map_err(|e| format!("Failed to run node: {e}"))?;
    if !output.status.success() {
        return Err("Failed to determine the Node.js install location.".into());
    }
    let node_exe = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let node_dir = node_exe.parent().ok_or_else(|| "Could not determine Node.js's install directory.".to_string())?;

    let npm_cli_js = node_dir.join("node_modules").join("npm").join("bin").join("npm-cli.js");
    if npm_cli_js.exists() {
        return Ok((node_exe.clone(), npm_cli_js));
    }
    Err(format!("Could not find npm's CLI entry point relative to {}", node_exe.display()))
}

// Runs `npm install` in server/ and streams its output to the same
// "server-log" event the terminal panel already listens to (prefixed
// "[install]" so it's distinguishable from runtime server logs). Awaited
// to completion rather than tracked in ServerProcess - this is a
// one-shot setup step, not something the launcher needs to be able to
// kill mid-flight the way the long-running server process is.
#[tauri::command]
async fn install_server_deps(app: AppHandle, repo_path: String) -> Result<(), String> {
    let server_dir = PathBuf::from(&repo_path).join("server");
    if !server_dir.join("package.json").exists() {
        return Err(format!("No server/package.json found under {}", repo_path));
    }

    let _ = app.emit("server-log", "[install] Running npm install in server/ ...".to_string());

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let (node_exe, npm_cli_js) = resolve_npm_cli_js().await?;
        let mut cmd = Command::new(&node_exe);
        cmd.arg(&npm_cli_js);
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new("npm");

    cmd.arg("install")
        .current_dir(&server_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to run npm install: {e}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let app_out = app.clone();
    let out_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit("server-log", format!("[install] {line}"));
        }
    });
    let app_err = app.clone();
    let err_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit("server-log", format!("[install] {line}"));
        }
    });

    let status = child.wait().await.map_err(|e| format!("npm install failed to run: {e}"))?;
    let _ = out_task.await;
    let _ = err_task.await;

    if status.success() {
        let _ = app.emit("server-log", "[install] npm install finished successfully.".to_string());
        Ok(())
    } else {
        Err(format!("npm install exited with status {status}"))
    }
}

// Copies scripts/Market Sync.pluto from the OpenMarket repo into the
// user's configured Pluto scripts folder - but ONLY if it's not already
// there. Never overwrites: the destination copy may have been
// deliberately edited in-game (dev-vs-live convention elsewhere in this
// project draws the same line), and silently clobbering that would be a
// real loss, not a convenience.
#[tauri::command]
async fn install_pluto_script(app: AppHandle, repo_path: String, scripts_dir: String) -> Result<(), String> {
    let source = PathBuf::from(&repo_path).join("scripts").join("Market Sync.pluto");
    if !source.exists() {
        return Err(format!(
            "{} not found - is the repo path pointing at a real OpenMarket checkout?",
            source.display()
        ));
    }
    let dest_dir = PathBuf::from(&scripts_dir);
    if !dest_dir.is_dir() {
        return Err(format!("{} is not a folder", dest_dir.display()));
    }
    let dest = dest_dir.join("Market Sync.pluto");
    if dest.exists() {
        return Ok(());
    }
    std::fs::copy(&source, &dest).map_err(|e| format!("Failed to copy Market Sync.pluto: {e}"))?;
    let _ = app.emit("server-log", format!("[install] Copied Market Sync.pluto to {}", dest_dir.display()));
    Ok(())
}

#[tauri::command]
async fn start_server(
    app: AppHandle,
    state: State<'_, ServerProcess>,
    repo_path: String,
    port: u16,
) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Err("Server is already running.".into());
    }

    let server_dir = PathBuf::from(&repo_path).join("server");
    let tsx_entry = tsx_entry_path(&repo_path);
    if !tsx_entry.exists() {
        return Err(format!(
            "tsx not found at {} - run Install first.",
            tsx_entry.display()
        ));
    }

    let mut cmd = Command::new("node");
    cmd.arg(&tsx_entry)
        .arg("src/index.ts")
        .current_dir(&server_dir)
        .env("MARKET_EMULATOR_PORT", port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn server process: {e}"))?;

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let app_out = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit("server-log", line);
        }
    });

    let app_err = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit("server-log", format!("[stderr] {line}"));
        }
    });

    *guard = Some(child);
    let _ = app.emit(
        "server-log",
        format!("Launcher: spawned server in {} on port {port}", server_dir.display()),
    );
    Ok(())
}

#[tauri::command]
async fn stop_server(app: AppHandle, state: State<'_, ServerProcess>) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    match guard.take() {
        Some(mut child) => {
            child.kill().await.map_err(|e| format!("Failed to stop server: {e}"))?;
            let _ = app.emit("server-log", "Launcher: server stopped.".to_string());
            Ok(())
        }
        None => Err("Server is not running.".into()),
    }
}

// Reports whether the supervised child is still alive - distinct from
// the /api/status HTTP check (fetch_server_status below), which reports
// whether Express actually came up and is answering requests. A process
// can be alive but not yet listening (still starting) or an npm/tsx
// crash can exit the process without the launcher having called
// stop_server - this is what catches that case.
#[tauri::command]
async fn is_server_running(state: State<'_, ServerProcess>) -> Result<bool, String> {
    let mut guard = state.0.lock().await;
    match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                Ok(false)
            }
            Ok(None) => Ok(true),
            Err(e) => Err(e.to_string()),
        },
        None => Ok(false),
    }
}

#[tauri::command]
async fn fetch_server_status(port: u16) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{port}/api/status");
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

// Closing the launcher via its own window (the X button, Alt+F4, etc.)
// already goes through the CloseRequested handler below - but that's not
// the only way a Linux desktop app gets terminated. A taskbar/dock
// "Quit", a session logout, or a plain `kill`/Ctrl+C in a launching
// terminal all deliver SIGTERM (or SIGINT) directly to the process,
// bypassing the windowing system's close protocol entirely. Neither Rust
// nor Tauri installs a handler for those by default, so without this the
// process just dies immediately - orphaning the supervised Node server,
// which keeps holding the port and blocks the NEXT launch (including
// right after an auto-update) from starting it. Reported 2026-09-20 by a
// Linux tester; not a gap Windows shares (its equivalent close paths
// already funnel through WM_CLOSE -> CloseRequested).
//
// Deliberately does NOT use PR_SET_PDEATHSIG (the more bulletproof
// Linux-native "kill my child no matter how I die" mechanism) - its
// semantics track the specific OS THREAD that forked the child, not the
// process as a whole (see `man 2 prctl`), which is a real footgun on a
// multi-threaded tokio runtime (`rt-multi-thread` is in use here): the
// tracked thread could get recycled by tokio's own thread pool while the
// app is still very much alive, killing the server out from under a
// running session for no visible reason. A plain signal handler has no
// such risk and still covers every case except an uncatchable SIGKILL -
// which nothing in userspace can handle in any language, so it isn't a
// gap this fix could close anyway.
#[cfg(unix)]
fn install_unix_signal_shutdown_handler(app: AppHandle) {
    use tokio::signal::unix::{signal, SignalKind};
    tauri::async_runtime::spawn(async move {
        let mut sigterm = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Failed to install SIGTERM handler: {e}");
                return;
            }
        };
        let mut sigint = match signal(SignalKind::interrupt()) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Failed to install SIGINT handler: {e}");
                return;
            }
        };
        tokio::select! {
            _ = sigterm.recv() => {}
            _ = sigint.recv() => {}
        }
        let state = app.state::<ServerProcess>();
        if let Some(mut child) = state.0.lock().await.take() {
            let _ = child.kill().await;
        }
        app.exit(0);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ServerProcess(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            check_node,
            validate_repo_path,
            validate_pluto_scripts_dir,
            check_server_deps,
            install_server_deps,
            install_pluto_script,
            start_server,
            stop_server,
            is_server_running,
            fetch_server_status
        ])
        .setup(|_app| {
            #[cfg(unix)]
            install_unix_signal_shutdown_handler(_app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Don't leave the supervised server running as an orphan
            // when the launcher window closes - the whole point of the
            // launcher owning the process is that closing it means the
            // server stops too (same expectation as closing a terminal
            // that has `npm start` running in it).
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<ServerProcess>();
                let proc = state.0.clone();
                tauri::async_runtime::block_on(async move {
                    if let Some(mut child) = proc.lock().await.take() {
                        let _ = child.kill().await;
                    }
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
