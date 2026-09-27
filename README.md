# Goki

Goki 是一个跨平台桌面悬浮助手。它使用 Tauri 2、Rust 和 TypeScript 构建，运行时显示一个无嘴巴的 Grok 风格表情球，可用于快速搜索文件、处理压缩包和反馈当前系统状态。

## 功能

- 始终置顶的透明悬浮 Bot 窗口
- 点击 Bot 打开文件搜索 HUD
- 使用全局快捷键打开搜索 HUD
- 键盘上下选择搜索结果，Enter 打开结果
- 根据操作系统使用原生文件管理器打开文件或文件夹
- 拖动 Bot 移动悬浮窗口
- 在 Bot 上滚动鼠标缩放表情球
- 将文件夹拖到 Bot 上压缩为 ZIP
- 将 ZIP 拖到 Bot 上解压到桌面
- 根据 CPU 使用率切换睡眠、待机、专注和过载表情
- 拖拽、处理中、成功和错误状态表情反馈

## 平台支持

| 平台 | 全局快捷键 | 文件管理器 |
| --- | --- | --- |
| Windows | `Ctrl + Shift + Space` | Windows Explorer |
| macOS | `Command + Shift + Space` | Finder |
| Linux | `Ctrl + Shift + Space` | 系统默认文件管理器 |

搜索行为也会根据平台适配。macOS 使用 Spotlight `mdfind`，避免应用递归读取受保护的用户目录；Windows 和 Linux 从当前用户主目录搜索。

## 环境要求

- Node.js 20 或更高版本
- Rust stable 工具链
- Tauri 2 对应的平台依赖

macOS 需要安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

安装 Rust：

```bash
brew install rustup
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
rustup toolchain install stable
rustup default stable
```

## 开发运行

在项目根目录执行：

```bash
npm install
npm run tauri dev
```

只运行前端构建检查：

```bash
npm run build
```

运行 Rust 检查：

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
```

## 构建应用

```bash
npm run tauri build
```

必须在目标操作系统上构建对应的原生应用包。macOS 的应用通常位于：

```text
src-tauri/target/release/bundle/macos/Goki.app
```

Windows 和 Linux 的输出目录分别位于 `src-tauri/target/release/bundle/` 下对应的平台目录。

## macOS 权限

首次运行 macOS 版本时，如果全局快捷键没有响应，请在：

系统设置 → 隐私与安全性 → 输入监控

中允许 Goki 访问键盘输入。

项目启用了 Tauri 的 macOS 透明窗口支持，因此需要重新启动 `npm run tauri dev` 才能加载透明窗口配置的修改。

## 使用说明

- 点击 Bot：打开搜索窗口
- 按住 Bot 并移动鼠标：拖动悬浮窗口
- 在 Bot 上滚动鼠标：放大或缩小 Bot
- `Command/Ctrl + Shift + Space`：打开搜索窗口
- 搜索窗口中使用 `Up` / `Down` 选择，`Enter` 打开，`Esc` 关闭
- 将文件夹拖到 Bot：生成桌面 ZIP
- 将 ZIP 拖到 Bot：解压到桌面

Bot 的睡眠表情会在 CPU 使用率低于 10% 时出现。它不会因为长时间闲置自动睡眠。

## 项目结构

```text
.
├── src/
│   ├── main.ts       # 宠物窗口、搜索 HUD 和交互逻辑
│   └── styles.css    # 窗口和 HUD 样式
├── public/
│   ├── grok-ball.js  # Grok Ball SVG 表情引擎
│   └── THIRD_PARTY_NOTICES.md
├── src-tauri/
│   ├── src/lib.rs    # 搜索、压缩、解压和平台适配
│   ├── tauri.conf.json
│   └── capabilities/
├── index.html
├── package.json
└── vite.config.ts
```

## 第三方许可

`public/grok-ball.js` 来自 [TyCoding/grok-ball](https://github.com/TyCoding/grok-ball)，该项目使用 MIT License。它是受 Grok Orb 启发的独立实现，与 xAI 没有官方关联。

完整署名和许可文本见 [public/THIRD_PARTY_NOTICES.md](public/THIRD_PARTY_NOTICES.md)。

## 许可证

Goki 项目本身尚未单独声明开源许可证。发布或分发前，请根据项目实际用途补充许可证文件，并同时保留第三方依赖的许可和署名信息。
