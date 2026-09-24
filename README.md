# Goki

Windows-first desktop companion implemented with a Rust/Tauri backend.

## Current features

- Transparent always-on-top pet window.
- Ctrl + Shift + Space global shortcut opens the centered search HUD.
- Filename search in the current Windows user folder.
- Keyboard navigation and opening results in Windows Explorer.
- Drop a folder to create a zip on the Desktop.
- Drop a zip archive to extract it on the Desktop.
- CPU-driven pet expressions and drag/drop feedback.

## Windows setup

Install the Rust MSVC toolchain, Visual Studio Build Tools with the Desktop
C++ workload, WebView2, and Node.js. Then run:

    npm install
    npm run tauri dev

Create a release build with:

    npm run tauri build

The current WSL workspace does not contain the Windows MSVC toolchain, so the
Windows build must be run from native Windows.
