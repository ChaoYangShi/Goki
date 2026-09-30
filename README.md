# Goki

Goki 是一个基于 Tauri 2、Rust 和 TypeScript 的跨平台桌面悬浮助手。它提供文件搜索、文件夹压缩/解压、系统托盘以及 SSH/SFTP 远程文件浏览功能。

## 功能

- 悬浮球、全局快捷键和键盘操作
- 本地文件搜索，并通过系统文件管理器打开结果
- 将文件夹拖到悬浮球压缩为 ZIP，将 ZIP 拖入后解压到桌面
- SSH/SFTP 连接、远程目录浏览、文件下载和拖拽上传
- 主机指纹确认，避免首次连接时无提示信任远端主机
- 系统托盘退出和 CPU 状态表情反馈

## SSH 使用

1. 从搜索 HUD 或托盘菜单打开 **SSH 连接**。
2. 输入 `user@host`，也可以指定端口，例如 `deploy@example.com:2222`。
3. 首次连接时核对显示的主机指纹，确认无误后点击“信任并继续”。
4. 输入密码完成登录。登录成功后可以浏览远程目录。
5. 单击条目选中，双击文件夹进入目录，双击文件下载；也可以使用行末下载按钮。
6. 使用工具栏按钮新建目录、重命名或删除选中项。将本地文件拖入远程文件列表，可上传到当前目录。

支持 IPv6 地址格式，例如 `user@[2001:db8::10]:22`。连接窗口关闭不会退出 Goki；使用“断开”按钮释放当前 SSH 会话。

### SSH 当前限制

- 当前认证方式为密码认证，暂不支持私钥、SSH Agent、`~/.ssh/config` 或 ProxyJump。
- 主机信任信息保存在应用配置目录的 `known_hosts.json` 中；如果远端指纹变化，需要重新确认。
- 上传和下载暂不提供进度、取消、断点续传或并发任务列表。
- 远程目录列表和传输操作仍是同步执行的，大文件或高延迟连接可能暂时影响窗口响应。
- 远程文件上传不会递归处理目录；同名远程文件不会覆盖，会报告为失败。
- 删除操作只删除文件或空目录，非空目录需要先清理内容。
- 仅支持远程文件浏览和 SFTP 传输，不包含远程 Shell 终端。

## 平台支持

| 平台 | 全局快捷键 | 文件管理器 |
| --- | --- | --- |
| Windows | `Ctrl + Shift + Space` | Windows Explorer |
| macOS | `Command + Shift + Space` | Finder |
| Linux | `Ctrl + Shift + Space` | 系统默认文件管理器 |

macOS 使用 Spotlight (`mdfind`) 搜索；Windows 和 Linux 默认扫描当前用户主目录。

## 环境要求

- Node.js 20 或更高版本
- Rust stable 工具链和 Cargo
- Tauri 2 所需的系统依赖
- macOS 需要 Xcode Command Line Tools

## 开发与测试

```bash
npm install
npm run tauri dev
```

仅构建前端：

```bash
npm run build
```

检查和测试 Rust 代码：

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

构建发行包：

```bash
npm run tauri build
```

SSH 的集成验证需要一台可访问的 SSH/SFTP 服务器。建议覆盖密码错误、主机指纹变化、IPv4/IPv6、无权限目录、中文文件名、同名文件以及大文件传输等场景。

## 项目结构

```text
.
├── src/
│   ├── main.ts       # 悬浮球、搜索 HUD 和 SSH 远程窗口
│   └── styles.css    # 窗口样式
├── public/
├── src-tauri/
│   ├── src/main.rs   # Tauri 入口
│   ├── src/lib.rs    # 搜索、压缩、SSH/SFTP、托盘和平台适配
│   ├── Cargo.toml
│   └── tauri.conf.json
└── package.json
```

## 第三方许可

`public/grok-ball.js` 来自 [TyCoding/grok-ball](https://github.com/TyCoding/grok-ball)，使用 MIT License。完整声明见 [public/THIRD_PARTY_NOTICES.md](public/THIRD_PARTY_NOTICES.md)。

Goki 项目本身尚未单独声明开源许可证。发布或分发前，请补充项目许可证并保留第三方依赖的版权和许可证信息。
