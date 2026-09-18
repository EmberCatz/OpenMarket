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

#[tauri::command]
async fn validate_repo_path(repo_path: String) -> Result<bool, String> {
    Ok(PathBuf::from(&repo_path).join("server").join("package.json").exists())
}

#[tauri::command]
async fn validate_pluto_scripts_dir(dir: String) -> Result<bool, String> {
    Ok(PathBuf::from(&dir).join("Market Sync.pluto").exists())
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
    let tsx_entry = server_dir.join("node_modules").join("tsx").join("dist").join("cli.mjs");
    if !tsx_entry.exists() {
        return Err(format!(
            "tsx not found at {} - run `npm install` in {} first.",
            tsx_entry.display(),
            server_dir.display()
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(ServerProcess(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            validate_repo_path,
            validate_pluto_scripts_dir,
            start_server,
            stop_server,
            is_server_running,
            fetch_server_status
        ])
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
