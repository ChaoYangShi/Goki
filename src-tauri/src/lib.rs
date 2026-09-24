use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use global_hotkey::{
    hotkey::{Code, HotKey, Modifiers},
    GlobalHotKeyEvent, GlobalHotKeyManager,
};
use serde::Serialize;
use sysinfo::{CpuExt, System, SystemExt};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WindowEvent};
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

fn search_roots() -> Vec<PathBuf> {
    dirs::home_dir().into_iter().collect()
}

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

    Err(format!("暂不处理该类型: {}", path.display()))
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
    let stem = base.file_stem().and_then(|name| name.to_str()).unwrap_or("archive");
    let extension = base.extension().and_then(|name| name.to_str()).unwrap_or("zip");
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
    let mut command = std::process::Command::new("explorer.exe");
    if kind == "file" {
        command.arg("/select,");
    }
    command
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(io_error)
}

fn install_global_hotkey(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let manager: &'static GlobalHotKeyManager = Box::leak(Box::new(GlobalHotKeyManager::new()?));
    let hotkey = HotKey::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
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
        .setup(|app| {
            place_pet(app);
            install_global_hotkey(app).map_err(|error| error.to_string())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "hud" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                WindowEvent::Focused(false) => {
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            search_files,
            cpu_usage,
            process_drop,
            show_hud,
            hide_hud,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Goki");
}
