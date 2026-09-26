# Goki

Cross-platform desktop companion implemented with a Rust/Tauri backend.

## Current features

- Transparent always-on-top pet window.
- Platform-specific global shortcut opens the centered search HUD.
- Filename search in the current user's home folder.
- Keyboard navigation and opening results in the native file manager.
- Drop a folder to create a zip on the Desktop.
- Drop a zip archive to extract it on the Desktop.
- CPU-driven pet expressions and drag/drop feedback using the MIT-licensed
  `grok-ball` SVG engine.

## Setup

Install Rust, Node.js, and the platform prerequisites for Tauri 2. Then run:

    npm install
    npm run tauri dev

Create a release build with:

    npm run tauri build

Build on the target operating system to produce its native application bundle.

### Platform behavior

- Windows uses `Ctrl + Shift + Space`, Windows Explorer, and the Desktop folder.
- macOS uses `Command + Shift + Space`, Finder, and the Desktop folder.
- Linux uses `Ctrl + Shift + Space`, the system file manager, and the Desktop folder.

On macOS, the first launch may require allowing global keyboard monitoring in
System Settings > Privacy & Security > Input Monitoring.

The bundled `public/grok-ball.js` is adapted from
[TyCoding/grok-ball](https://github.com/TyCoding/grok-ball) under the MIT
License. See `public/THIRD_PARTY_NOTICES.md` for the attribution.
