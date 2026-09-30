use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io,
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use global_hotkey::{
    hotkey::{Code, HotKey, Modifiers},
    GlobalHotKeyEvent, GlobalHotKeyManager,
};
use serde::Serialize;
use ssh2::{HashType, Session};
use sysinfo::System;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
#[cfg(not(target_os = "macos"))]
use walkdir::WalkDir;
use zip::{read::ZipArchive, write::FileOptions, CompressionMethod, ZipWriter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    name: String,
    path: String,
    kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationResult {
    kind: String,
    path: String,
    message: String,
}

struct PendingSsh {
    session: Session,
    username: String,
    host: String,
    port: u16,
    fingerprint: String,
    created_at: Instant,
}

struct ActiveSsh {
    session: Session,
    cwd: String,
    last_used: Instant,
}

#[derive(Default)]
struct SshState {
    pending: Mutex<HashMap<String, PendingSsh>>,
    sessions: Mutex<HashMap<String, ActiveSsh>>,
    trusted: Mutex<HashSet<String>>,
    trusted_loaded: Mutex<bool>,
}

fn trusted_hosts_path() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("goki").join("known_hosts.json"))
}

fn load_trusted_hosts(state: &SshState) {
    let Ok(mut loaded) = state.trusted_loaded.lock() else {
        return;
    };
    if *loaded {
        return;
    }
    if let Some(path) = trusted_hosts_path() {
        if let Ok(contents) = fs::read_to_string(path) {
            if let Ok(entries) = serde_json::from_str::<Vec<String>>(&contents) {
                if let Ok(mut trusted) = state.trusted.lock() {
                    trusted.extend(entries);
                }
            }
        }
    }
    *loaded = true;
}

fn save_trusted_hosts(state: &SshState) -> Result<(), String> {
    let Some(path) = trusted_hosts_path() else {
        return Ok(());
    };
    let entries = state
        .trusted
        .lock()
        .map_err(|_| "SSH 状态锁定失败")?
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let temp = path.with_extension("json.tmp");
    fs::write(
        &temp,
        serde_json::to_vec_pretty(&entries).map_err(io_error)?,
    )
    .map_err(io_error)?;
    fs::rename(temp, path).map_err(io_error)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshPrepareResult {
    attempt_id: String,
    host: String,
    port: u16,
    username: String,
    fingerprint: String,
    auth_methods: Vec<String>,
    trusted: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshAuthResult {
    session_id: String,
    username: String,
    host: String,
    cwd: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteEntry {
    name: String,
    path: String,
    kind: String,
    size: u64,
    modified: Option<u64>,
}

fn new_id(prefix: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}-{now:x}")
}

const PENDING_SSH_TTL: Duration = Duration::from_secs(5 * 60);
const ACTIVE_SSH_TTL: Duration = Duration::from_secs(24 * 60 * 60);

fn ssh_trust_key(host: &str, port: u16, fingerprint: &str) -> String {
    format!("{host}:{port}:{fingerprint}")
}

fn cleanup_ssh_state(state: &SshState) {
    if let Ok(mut pending) = state.pending.lock() {
        pending.retain(|_, attempt| attempt.created_at.elapsed() < PENDING_SSH_TTL);
    }
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.retain(|_, session| session.last_used.elapsed() < ACTIVE_SSH_TTL);
    }
}

fn parse_ssh_target(target: &str) -> Result<(String, String, u16), String> {
    let (username, address) = target
        .trim()
        .split_once('@')
        .ok_or_else(|| "请输入 user@host 或 user@host:port".to_owned())?;
    if username.is_empty() || address.is_empty() {
        return Err("用户名和主机地址不能为空".to_owned());
    }
    let (host, port) = if let Some(rest) = address.strip_prefix('[') {
        let (host, suffix) = rest
            .split_once(']')
            .ok_or_else(|| "IPv6 地址格式错误".to_owned())?;
        let port = suffix.strip_prefix(':').unwrap_or("22");
        (
            host.to_owned(),
            port.parse::<u16>().map_err(|_| "端口格式错误".to_owned())?,
        )
    } else if let Some((host, port)) = address.rsplit_once(':') {
        if host.contains(':') {
            (address.to_owned(), 22)
        } else {
            (
                host.to_owned(),
                port.parse::<u16>().map_err(|_| "端口格式错误".to_owned())?,
            )
        }
    } else {
        (address.to_owned(), 22)
    };
    if host.is_empty() || port == 0 {
        return Err("主机地址或端口无效".to_owned());
    }
    Ok((username.to_owned(), host, port))
}

fn remote_join(directory: &str, name: &str) -> String {
    let directory = if directory.is_empty() { "/" } else { directory };
    if directory == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", directory.trim_end_matches('/'), name)
    }
}

#[tauri::command]
fn ssh_prepare(target: String, state: State<'_, SshState>) -> Result<SshPrepareResult, String> {
    cleanup_ssh_state(&state);
    load_trusted_hosts(&state);
    let (username, host, port) = parse_ssh_target(&target)?;
    let mut addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析主机 {host}: {error}"))?;
    let tcp = addresses
        .find_map(|address| TcpStream::connect_timeout(&address, Duration::from_secs(10)).ok())
        .ok_or_else(|| format!("无法连接到 {host}:{port}"))?;
    tcp.set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(io_error)?;
    tcp.set_write_timeout(Some(Duration::from_secs(15)))
        .map_err(io_error)?;
    let mut session = Session::new().map_err(io_error)?;
    session.set_tcp_stream(tcp);
    session.handshake().map_err(io_error)?;
    let fingerprint = session
        .host_key_hash(HashType::Sha256)
        .map(|bytes| {
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        })
        .ok_or_else(|| "远端没有提供主机指纹".to_owned())?;
    let trusted = state
        .trusted
        .lock()
        .map_err(|_| "SSH 状态锁定失败")?
        .contains(&ssh_trust_key(&host, port, &fingerprint));
    let auth_methods = session
        .auth_methods(&username)
        .map_err(io_error)?
        .split(',')
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let attempt_id = new_id("ssh-attempt");
    state
        .pending
        .lock()
        .map_err(|_| "SSH 状态锁定失败")?
        .insert(
            attempt_id.clone(),
            PendingSsh {
                session,
                username: username.clone(),
                host: host.clone(),
                port,
                fingerprint: fingerprint.clone(),
                created_at: Instant::now(),
            },
        );
    Ok(SshPrepareResult {
        attempt_id,
        host,
        port,
        username,
        fingerprint,
        auth_methods,
        trusted,
    })
}

#[tauri::command]
fn ssh_trust(attempt_id: String, state: State<'_, SshState>) -> Result<(), String> {
    cleanup_ssh_state(&state);
    load_trusted_hosts(&state);
    let pending = state.pending.lock().map_err(|_| "SSH 状态锁定失败")?;
    let attempt = pending
        .get(&attempt_id)
        .ok_or_else(|| "SSH 连接已过期".to_owned())?;
    state
        .trusted
        .lock()
        .map_err(|_| "SSH 状态锁定失败")?
        .insert(ssh_trust_key(
            &attempt.host,
            attempt.port,
            &attempt.fingerprint,
        ));
    save_trusted_hosts(&state)?;
    Ok(())
}

#[tauri::command]
fn ssh_authenticate(
    attempt_id: String,
    password: String,
    state: State<'_, SshState>,
) -> Result<SshAuthResult, String> {
    cleanup_ssh_state(&state);
    let mut pending = state.pending.lock().map_err(|_| "SSH 状态锁定失败")?;
    let attempt = pending
        .remove(&attempt_id)
        .ok_or_else(|| "SSH 连接已过期".to_owned())?;
    let trusted = state
        .trusted
        .lock()
        .map_err(|_| "SSH 状态锁定失败")?
        .contains(&ssh_trust_key(
            &attempt.host,
            attempt.port,
            &attempt.fingerprint,
        ));
    if !trusted {
        pending.insert(attempt_id, attempt);
        return Err("请先确认远端主机指纹".to_owned());
    }
    let PendingSsh {
        session,
        username,
        host,
        port,
        fingerprint,
        ..
    } = attempt;
    if let Err(error) = session.userauth_password(&username, &password) {
        pending.insert(
            attempt_id,
            PendingSsh {
                session,
                username,
                host,
                port,
                fingerprint,
                created_at: Instant::now(),
            },
        );
        return Err(format!("密码认证失败: {error}"));
    }
    if !session.authenticated() {
        return Err("服务器拒绝了密码认证".to_owned());
    }
    let sftp = session.sftp().map_err(io_error)?;
    let cwd = sftp
        .realpath(Path::new("."))
        .map_err(io_error)?
        .to_string_lossy()
        .into_owned();
    let session_id = new_id("ssh-session");
    let result = SshAuthResult {
        session_id: session_id.clone(),
        username: username.clone(),
        host: host.clone(),
        cwd: cwd.clone(),
    };
    state
        .sessions
        .lock()
        .map_err(|_| "SSH 状态锁定失败")?
        .insert(
            session_id,
            ActiveSsh {
                session,
                cwd,
                last_used: Instant::now(),
            },
        );
    Ok(result)
}

#[tauri::command]
fn ssh_list(
    session_id: String,
    path: String,
    state: State<'_, SshState>,
) -> Result<Vec<RemoteEntry>, String> {
    cleanup_ssh_state(&state);
    let mut sessions = state.sessions.lock().map_err(|_| "SSH 状态锁定失败")?;
    let active = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "SSH 会话不存在".to_owned())?;
    active.last_used = Instant::now();
    let sftp = active.session.sftp().map_err(io_error)?;
    let directory = if path.trim().is_empty() {
        active.cwd.as_str()
    } else {
        path.trim()
    };
    let mut entries = sftp
        .readdir(Path::new(directory))
        .map_err(io_error)?
        .into_iter()
        .filter_map(|(path, stat)| {
            let name = path.file_name()?.to_string_lossy().into_owned();
            if name == "." || name == ".." {
                return None;
            }
            let is_directory = stat
                .perm
                .map(|permissions| permissions & 0o170000 == 0o040000)
                .unwrap_or(false);
            let kind = if is_directory { "folder" } else { "file" };
            Some(RemoteEntry {
                name: name.clone(),
                path: remote_join(directory, &name),
                kind: kind.to_owned(),
                size: stat.size.unwrap_or(0),
                modified: stat.mtime,
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| (entry.kind != "folder", entry.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
fn ssh_download(
    session_id: String,
    remote_path: String,
    local_path: String,
    app: AppHandle,
    state: State<'_, SshState>,
) -> Result<String, String> {
    cleanup_ssh_state(&state);
    if remote_path.trim().is_empty() || remote_path.contains('\0') {
        return Err("remote file path is invalid".to_owned());
    }
    let mut sessions = state.sessions.lock().map_err(|_| "SSH 状态锁定失败")?;
    let active = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "SSH 会话不存在".to_owned())?;
    active.last_used = Instant::now();
    let sftp = active.session.sftp().map_err(io_error)?;
    let mut source = sftp.open(Path::new(&remote_path)).map_err(io_error)?;
    let file_name = remote_path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("download");
    let mut destination = if local_path.trim().is_empty() {
        unique_file(
            &dirs::download_dir()
                .or_else(dirs::home_dir)
                .ok_or_else(|| "找不到本地下载目录".to_owned())?
                .join(file_name),
        )
    } else {
        PathBuf::from(&local_path)
    };
    if destination.exists() {
        destination = unique_file(&destination);
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let temporary = destination.with_extension(format!("goki-part-{}", new_id("download")));
    let mut output = File::create(&temporary).map_err(io_error)?;
    if let Err(error) = io::copy(&mut source, &mut output).map_err(io_error) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    drop(output);
    if let Err(error) = fs::rename(&temporary, &destination).map_err(io_error) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let destination_string = destination.to_string_lossy().into_owned();
    let _ = app.emit_to("remote", "sftp-transfer", serde_json::json!({ "kind": "download", "path": destination_string, "status": "completed" }));
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn ssh_upload(
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    app: AppHandle,
    state: State<'_, SshState>,
) -> Result<Vec<String>, String> {
    cleanup_ssh_state(&state);
    if remote_dir.contains('\0') {
        return Err("remote directory path is invalid".to_owned());
    }
    let mut sessions = state.sessions.lock().map_err(|_| "SSH 状态锁定失败")?;
    let active = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "SSH 会话不存在".to_owned())?;
    active.last_used = Instant::now();
    let sftp = active.session.sftp().map_err(io_error)?;
    let mut uploaded = Vec::new();
    let mut failures = Vec::new();
    for local in local_paths {
        let source_path = PathBuf::from(&local);
        if !source_path.is_file() {
            failures.push(format!("{local}: not a regular file"));
            continue;
        }
        let name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "无法读取本地文件名".to_owned())?;
        let remote_path = remote_join(&remote_dir, name);
        if sftp.stat(Path::new(&remote_path)).is_ok() {
            failures.push(format!("{remote_path}: remote file already exists"));
            continue;
        }
        let temporary = format!("{remote_path}.goki-part-{}", new_id("upload"));
        let result = (|| -> Result<(), String> {
            let mut input = File::open(&source_path).map_err(io_error)?;
            {
                let mut output = sftp.create(Path::new(&temporary)).map_err(io_error)?;
                io::copy(&mut input, &mut output).map_err(io_error)?;
            }
            sftp.rename(Path::new(&temporary), Path::new(&remote_path), None)
                .map_err(io_error)
        })();
        if let Err(error) = result {
            let _ = sftp.unlink(Path::new(&temporary));
            failures.push(format!("{remote_path}: {error}"));
            continue;
        }
        uploaded.push(remote_path);
    }
    let _ = app.emit_to(
        "remote",
        "sftp-transfer",
        serde_json::json!({ "kind": "upload", "paths": uploaded, "failures": failures, "status": "completed" }),
    );
    Ok(uploaded)
}

#[tauri::command]
fn ssh_disconnect(session_id: String, state: State<'_, SshState>) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|_| "SSH 状态锁定失败")?
        .remove(&session_id);
    Ok(())
}

#[tauri::command]
fn ssh_mkdir(session_id: String, path: String, state: State<'_, SshState>) -> Result<(), String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("remote directory path is invalid".to_owned());
    }
    let mut sessions = state.sessions.lock().map_err(|_| "SSH 状态锁定失败")?;
    let active = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "SSH 会话不存在".to_owned())?;
    active.last_used = Instant::now();
    let sftp = active.session.sftp().map_err(io_error)?;
    sftp.mkdir(Path::new(&path), 0o755).map_err(io_error)
}

#[tauri::command]
fn ssh_rename(
    session_id: String,
    from: String,
    to: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    if from.trim().is_empty() || to.trim().is_empty() || from.contains('\0') || to.contains('\0') {
        return Err("remote path is invalid".to_owned());
    }
    let mut sessions = state.sessions.lock().map_err(|_| "SSH 状态锁定失败")?;
    let active = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "SSH 会话不存在".to_owned())?;
    active.last_used = Instant::now();
    let sftp = active.session.sftp().map_err(io_error)?;
    sftp.rename(Path::new(&from), Path::new(&to), None)
        .map_err(io_error)
}

#[tauri::command]
fn ssh_delete(session_id: String, path: String, state: State<'_, SshState>) -> Result<(), String> {
    if path.trim().is_empty() || path == "/" || path.contains('\0') {
        return Err("remote path is invalid".to_owned());
    }
    let mut sessions = state.sessions.lock().map_err(|_| "SSH 状态锁定失败")?;
    let active = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "SSH 会话不存在".to_owned())?;
    active.last_used = Instant::now();
    let sftp = active.session.sftp().map_err(io_error)?;
    let stat = sftp.stat(Path::new(&path)).map_err(io_error)?;
    let is_dir = stat
        .perm
        .map(|permissions| permissions & 0o170000 == 0o040000)
        .unwrap_or(false);
    if is_dir {
        sftp.rmdir(Path::new(&path)).map_err(io_error)
    } else {
        sftp.unlink(Path::new(&path)).map_err(io_error)
    }
}

#[tauri::command]
fn show_ssh_menu(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    let connect = MenuItemBuilder::with_id("ssh-connect", "SSH 连接")
        .build(&app)
        .map_err(io_error)?;
    let settings = MenuItemBuilder::with_id("settings", "外观设置")
        .build(&app)
        .map_err(io_error)?;
    let menu = MenuBuilder::new(&app)
        .items(&[&connect, &settings])
        .build()
        .map_err(io_error)?;
    window.popup_menu(&menu).map_err(io_error)
}

fn show_remote_window(app: &AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window("remote") {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, "remote", WebviewUrl::App("index.html".into()))
            .title("Goki SSH")
            .inner_size(980.0, 680.0)
            .min_inner_size(720.0, 480.0)
            .resizable(true)
            .build()
            .map_err(io_error)?,
    };
    window.show().map_err(io_error)?;
    window.set_focus().map_err(io_error)
}

#[tauri::command]
fn show_remote_window_command(app: AppHandle) -> Result<(), String> {
    show_remote_window(&app)
}

fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window("settings") {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
            .title("Goki 设置")
            .inner_size(520.0, 430.0)
            .min_inner_size(420.0, 360.0)
            .resizable(false)
            .build()
            .map_err(io_error)?,
    };
    window.center().map_err(io_error)?;
    window.show().map_err(io_error)?;
    window.set_focus().map_err(io_error)
}

#[tauri::command]
fn show_settings(app: AppHandle) -> Result<(), String> {
    show_settings_window(&app)
}

#[tauri::command]
fn hide_settings(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.hide().map_err(io_error)?;
    }
    Ok(())
}

#[tauri::command]
fn cpu_usage() -> f32 {
    let mut system = System::new();
    system.refresh_cpu();
    thread::sleep(Duration::from_millis(120));
    system.refresh_cpu();
    system.global_cpu_info().cpu_usage()
}

#[tauri::command]
async fn search_files(query: String) -> Result<Vec<SearchResult>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    tauri::async_runtime::spawn_blocking(move || search_files_blocking(&query))
        .await
        .map_err(|error| format!("搜索任务失败: {error}"))?
}

#[cfg(not(target_os = "macos"))]
fn search_files_blocking(query: &str) -> Result<Vec<SearchResult>, String> {
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();

    'search: for root in search_roots() {
        if !root.exists() {
            continue;
        }

        for entry in WalkDir::new(root)
            .follow_links(false)
            .max_depth(12)
            .into_iter()
            .filter_entry(|entry| entry.depth() == 0 || !should_skip_directory(entry.path()))
            .filter_map(Result::ok)
        {
            if results.len() >= 80 {
                break 'search;
            }

            let path = entry.path();
            if !entry.file_type().is_file() && !entry.file_type().is_dir() {
                continue;
            }

            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !name.to_lowercase().contains(query) {
                continue;
            }

            let path_string = path.to_string_lossy().into_owned();
            if !seen.insert(path_string.clone()) {
                continue;
            }

            results.push(SearchResult {
                name: name.to_owned(),
                path: path_string,
                kind: if entry.file_type().is_dir() {
                    "folder".to_owned()
                } else {
                    "file".to_owned()
                },
            });
        }
    }

    results.sort_by_key(|result| {
        (
            !result.name.to_lowercase().starts_with(query),
            result.name.to_lowercase(),
        )
    });
    Ok(results)
}

#[cfg(target_os = "macos")]
fn search_files_blocking(query: &str) -> Result<Vec<SearchResult>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let query = format!("name:{query}");
    let output = std::process::Command::new("/usr/bin/mdfind")
        .args([
            "-onlyin",
            home.to_string_lossy().as_ref(),
            "-interpret",
            &query,
        ])
        .output()
        .map_err(io_error)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }

    let mut results = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines().take(80) {
        let path = PathBuf::from(line);
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name
            .to_lowercase()
            .contains(query.trim_start_matches("name:").to_lowercase().as_str())
        {
            continue;
        }
        results.push(SearchResult {
            name: name.to_owned(),
            path: line.to_owned(),
            kind: if path.is_dir() { "folder" } else { "file" }.to_owned(),
        });
    }
    results.sort_by_key(|result| {
        (
            !result
                .name
                .to_lowercase()
                .starts_with(query.trim_start_matches("name:")),
            result.name.to_lowercase(),
        )
    });
    Ok(results)
}

#[cfg(not(target_os = "macos"))]
fn search_roots() -> Vec<PathBuf> {
    dirs::home_dir().into_iter().collect()
}

#[cfg(not(target_os = "macos"))]
fn should_skip_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                ".git" | "node_modules" | "target" | "appdata" | "$recycle.bin"
            )
        })
        .unwrap_or(false)
}

#[tauri::command]
async fn process_drop(paths: Vec<String>) -> Result<Vec<OperationResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| process_drop_path(PathBuf::from(path)))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| format!("文件任务失败: {error}"))?
    .into_iter()
    .collect()
}

fn process_drop_path(path: PathBuf) -> Result<OperationResult, String> {
    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }
    if path.is_dir() {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "无法读取文件夹名称".to_owned())?;
        let destination = unique_file(&desktop_dir().join(format!("{name}.zip")));
        zip_directory(&path, &destination)?;
        return Ok(OperationResult {
            kind: "compressed".to_owned(),
            path: destination.to_string_lossy().into_owned(),
            message: format!("已压缩到 {}", destination.display()),
        });
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "zip" {
        let name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "无法读取压缩包名称".to_owned())?;
        let destination = unique_directory(&desktop_dir().join(name));
        unzip_archive(&path, &destination)?;
        return Ok(OperationResult {
            kind: "extracted".to_owned(),
            path: destination.to_string_lossy().into_owned(),
            message: format!("已解压到 {}", destination.display()),
        });
    }

    if extension == "7z" {
        return Err("当前版本暂不支持 7z，先支持 zip 文件".to_owned());
    }

    Err(format!("只支持文件夹压缩和 ZIP 解压: {}", path.display()))
}

fn desktop_dir() -> PathBuf {
    dirs::desktop_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn unique_directory(base: &Path) -> PathBuf {
    if !base.exists() {
        return base.to_owned();
    }
    for index in 2..1000 {
        let candidate = base.with_file_name(format!(
            "{} ({index})",
            base.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("archive")
        ));
        if !candidate.exists() {
            return candidate;
        }
    }
    base.with_file_name("archive (new)")
}

fn unique_file(base: &Path) -> PathBuf {
    if !base.exists() {
        return base.to_owned();
    }
    let stem = base
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("archive");
    let extension = base
        .extension()
        .and_then(|name| name.to_str())
        .unwrap_or("zip");
    for index in 2..1000 {
        let candidate = base.with_file_name(format!("{stem} ({index}).{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    base.with_file_name(format!("{stem} (new).{extension}"))
}

fn zip_directory(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.starts_with(source) {
        return Err("压缩目标不能位于源文件夹内部".to_owned());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let file = File::create(destination).map_err(io_error)?;
    let mut writer = ZipWriter::new(file);
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
    append_directory(&mut writer, source, source, options)?;
    writer.finish().map_err(io_error)?;
    Ok(())
}

fn append_directory(
    writer: &mut ZipWriter<File>,
    root: &Path,
    current: &Path,
    options: FileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let relative = path.strip_prefix(root).map_err(io_error)?;
        let archive_name = relative.to_string_lossy().replace('\\', "/");
        if metadata.is_dir() {
            writer
                .add_directory(format!("{archive_name}/"), options)
                .map_err(io_error)?;
            append_directory(writer, root, &path, options)?;
        } else if metadata.is_file() {
            writer.start_file(archive_name, options).map_err(io_error)?;
            let mut input = File::open(&path).map_err(io_error)?;
            io::copy(&mut input, writer).map_err(io_error)?;
        }
    }
    Ok(())
}

fn unzip_archive(source: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(source).map_err(io_error)?;
    let mut archive = ZipArchive::new(file).map_err(io_error)?;
    fs::create_dir_all(destination).map_err(io_error)?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(io_error)?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| format!("压缩包包含不安全路径: {}", entry.name()))?
            .to_owned();
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(io_error)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let mut target = File::create(&output).map_err(io_error)?;
        io::copy(&mut entry, &mut target).map_err(io_error)?;
    }
    Ok(())
}

fn io_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
fn show_hud(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("hud")
        .ok_or_else(|| "搜索窗口不存在".to_owned())?;
    window.center().map_err(io_error)?;
    window.show().map_err(io_error)?;
    window.set_focus().map_err(io_error)?;
    let _ = app.emit("hud-opened", ());
    Ok(())
}

#[tauri::command]
fn hide_hud(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("hud") {
        window.hide().map_err(io_error)?;
    }
    Ok(())
}

#[tauri::command]
fn open_path(path: String, kind: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(format!("路径不存在: {}", path.display()));
    }

    // Use each platform's native file manager so search results open with the
    // expected selection and Finder/Explorer behavior.
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer.exe");
        if kind == "file" {
            command.arg("/select,");
        }
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        if kind == "file" {
            command.arg("-R");
        }
        command
    };

    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");

    command.arg(path).spawn().map(|_| ()).map_err(io_error)
}

fn install_global_hotkey(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let manager: &'static GlobalHotKeyManager = Box::leak(Box::new(GlobalHotKeyManager::new()?));
    #[cfg(target_os = "macos")]
    let modifier = Modifiers::SUPER;
    #[cfg(not(target_os = "macos"))]
    let modifier = Modifiers::CONTROL;
    let hotkey = HotKey::new(Some(modifier | Modifiers::SHIFT), Code::Space);
    manager.register(hotkey)?;

    let app_handle = app.handle().clone();
    std::thread::spawn(move || {
        let receiver = GlobalHotKeyEvent::receiver();
        while let Ok(event) = receiver.recv() {
            if event.id != hotkey.id() {
                continue;
            }
            if let Some(window) = app_handle.get_webview_window("hud") {
                let _ = window.center();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app_handle.emit("global-hotkey", ());
        }
    });
    Ok(())
}

fn place_pet(app: &tauri::App) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let width = (190.0 * scale) as i32;
    let height = (190.0 * scale) as i32;
    let size = monitor.size();
    let position = monitor.position();
    let x = position.x + size.width as i32 - width - (28.0 * scale) as i32;
    let y = position.y + size.height as i32 - height - (42.0 * scale) as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SshState::default())
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "ssh-connect" => {
                    let _ = show_remote_window(app);
                }
                "settings" => {
                    let _ = show_settings_window(app);
                }
                _ => {}
            }
        })
        .setup(|app| {
            let quit = MenuItemBuilder::with_id("quit", "退出 Goki").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&quit]).build()?;
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or("Goki 默认图标不可用")?,
                )
                .menu(&menu)
                .tooltip("Goki")
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .build(app)?;
            place_pet(app);
            install_global_hotkey(app).map_err(|error| error.to_string())?;
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            ("hud" | "remote" | "settings", WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            ("hud", WindowEvent::Focused(false)) => {
                let _ = window.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            search_files,
            cpu_usage,
            process_drop,
            ssh_prepare,
            ssh_trust,
            ssh_authenticate,
            ssh_list,
            ssh_download,
            ssh_upload,
            ssh_disconnect,
            ssh_mkdir,
            ssh_rename,
            ssh_delete,
            show_ssh_menu,
            show_remote_window_command,
            show_settings,
            hide_settings,
            show_hud,
            hide_hud,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Goki");
}

#[cfg(test)]
mod tests {
    use super::{parse_ssh_target, remote_join};

    #[test]
    fn parses_default_port() {
        assert_eq!(
            parse_ssh_target("alice@example.com").unwrap(),
            ("alice".to_owned(), "example.com".to_owned(), 22)
        );
    }

    #[test]
    fn parses_custom_port() {
        assert_eq!(
            parse_ssh_target("deploy@example.com:2222").unwrap(),
            ("deploy".to_owned(), "example.com".to_owned(), 2222)
        );
    }

    #[test]
    fn parses_bracketed_ipv6() {
        assert_eq!(
            parse_ssh_target("root@[2001:db8::10]:2200").unwrap(),
            ("root".to_owned(), "2001:db8::10".to_owned(), 2200)
        );
    }

    #[test]
    fn rejects_invalid_targets() {
        for target in [
            "example.com",
            "@example.com",
            "alice@",
            "alice@example.com:0",
        ] {
            assert!(
                parse_ssh_target(target).is_err(),
                "target should fail: {target}"
            );
        }
    }

    #[test]
    fn joins_remote_paths_without_duplicate_slashes() {
        assert_eq!(remote_join("/", "notes.txt"), "/notes.txt");
        assert_eq!(
            remote_join("/home/alice/", "notes.txt"),
            "/home/alice/notes.txt"
        );
        assert_eq!(remote_join("", "notes.txt"), "/notes.txt");
    }
}
