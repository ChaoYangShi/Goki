import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Menu } from "@tauri-apps/api/menu";
import { save } from "@tauri-apps/plugin-dialog";
import "./styles.css";

type SearchResult = {
  name: string;
  path: string;
  kind: "file" | "folder";
};

const RECENT_FILES_KEY = "goki.recent-files";
const MAX_RECENT_FILES = 8;

type DragPayload = {
  paths?: string[];
};

type GrokBallEngine = {
  setEmotion: (id: string, options?: { auto?: boolean }) => boolean;
  setGaze: (x: number, y: number) => GrokBallEngine;
  clearGaze: () => GrokBallEngine;
  bounce: () => GrokBallEngine;
  burst: (count?: number) => GrokBallEngine;
  spin: (turns?: number, direction?: -1 | 1) => GrokBallEngine;
};

declare global {
  interface Window {
    GrokBall?: {
      create: (
        target: Element,
        options?: {
          emotion?: string;
          color?: string;
          eyeColor?: string;
          shape?: "blob" | "wedge" | "gem";
          label?: string;
          idle?: boolean;
        },
      ) => GrokBallEngine;
    };
  }
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Goki root element is missing");
}

const currentWindow = getCurrentWindow();
if (currentWindow.label === "hud") {
  renderHud(app);
} else if (currentWindow.label === "remote") {
  renderRemote(app);
} else {
  renderPet(app);
}

function renderPet(root: HTMLDivElement) {
  root.innerHTML = `
    <main class="pet-shell" aria-label="Goki">
      <button class="pet" id="pet-button" aria-label="打开 Goki 搜索">
        <span class="pet-ball" id="pet-ball"></span>
      </button>
      <span class="pet-status" id="pet-status">清醒</span>
    </main>
  `;

  const shell = root.querySelector<HTMLElement>(".pet-shell")!;
  const button = root.querySelector<HTMLButtonElement>("#pet-button")!;
  const status = root.querySelector<HTMLElement>("#pet-status")!;
  const ballMount = root.querySelector<HTMLElement>("#pet-ball")!;
  const ball = window.GrokBall?.create(ballMount, {
    emotion: "02",
    color: "#15191d",
    eyeColor: "#f4f4f4",
    shape: "blob",
    label: "Goki",
    idle: false,
  });
  let zoom = 1;
  let suppressClick = false;
  let dragging: {
    pointerId: number;
    startX: number;
    startY: number;
    ready: boolean;
    moved: boolean;
    nativeStarted: boolean;
  } | undefined;

  button.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom = Math.min(1.55, Math.max(0.65, zoom + (event.deltaY < 0 ? 0.08 : -0.08)));
    ballMount.style.transform = `scale(${zoom})`;
  }, { passive: false });

  const setEmotion = (emotion: string) => {
    ball?.setEmotion(emotion);
  };

  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    button.setPointerCapture(event.pointerId);
    if (!button.hasPointerCapture(event.pointerId)) {
      return;
    }
    dragging = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      ready: true,
      moved: false,
      nativeStarted: false,
    };
  });
  button.addEventListener("pointermove", (event) => {
    if (!dragging?.ready || dragging.pointerId !== event.pointerId || event.buttons !== 1) {
      return;
    }
    const dx = event.clientX - dragging.startX;
    const dy = event.clientY - dragging.startY;
    if (Math.abs(dx) + Math.abs(dy) < 2) {
      return;
    }
    dragging.moved = true;
    suppressClick = true;
    if (!dragging.nativeStarted) {
      dragging.nativeStarted = true;
      void currentWindow.startDragging().catch((error) => {
        console.error("Unable to start native window dragging", error);
      });
    }
  });
  const finishDragging = (event: PointerEvent) => {
    if (dragging?.pointerId === event.pointerId) {
      dragging = undefined;
    }
    if (button.hasPointerCapture(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }
  };
  button.addEventListener("pointerup", finishDragging);
  button.addEventListener("pointercancel", finishDragging);

  button.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    void invoke("show_hud");
  });
  let sshMenu: Menu | undefined;
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void (async () => {
      try {
        sshMenu ??= await Menu.new({
          items: [{
            id: "ssh-connect",
            text: "SSH 连接",
            action: () => void invoke("show_remote_window_command"),
          }],
        });
        await sshMenu.popup(undefined, currentWindow);
      } catch (error) {
        console.error("Unable to show SSH menu", error);
        status.textContent = String(error);
        status.classList.add("is-visible");
      }
    })();
  });

  void listen<DragPayload>("tauri://drag-over", () => {
    shell.classList.add("is-dragging");
    setEmotion("31");
  });
  void listen("tauri://drag-leave", () => {
    shell.classList.remove("is-dragging");
    setEmotion("02");
  });
  void listen<DragPayload>("tauri://drag-drop", async (event) => {
    shell.classList.remove("is-dragging");
    const paths = event.payload.paths ?? [];
    if (paths.length === 0) {
      return;
    }

    shell.classList.add("is-processing");
    setEmotion("32");
    status.textContent = "处理中";
    try {
      const results = await invoke<Array<{ message: string; path: string; kind: string }>>("process_drop", { paths });
      status.textContent = results[0]?.message ?? "已完成";
      status.classList.add("is-visible");
      for (const result of results) {
        const kind = result.kind === "extracted" ? "folder" : "file";
        void invoke("open_path", { path: result.path, kind }).then(() => {
          rememberRecent({
            name: result.path.split(/[\\/]/).pop() ?? result.path,
            path: result.path,
            kind,
          });
        });
      }
      shell.classList.add("is-success");
      setEmotion("33");
      window.setTimeout(() => shell.classList.remove("is-success"), 1100);
    } catch (error) {
      status.textContent = String(error);
      status.classList.add("is-visible");
      shell.classList.add("is-error");
      setEmotion("34");
      window.setTimeout(() => shell.classList.remove("is-error"), 1400);
    } finally {
      shell.classList.remove("is-processing");
      window.setTimeout(() => {
        status.textContent = "清醒";
        status.classList.remove("is-visible");
        setEmotion("02");
      }, 1500);
    }
  });

  const updateCpuState = async () => {
    try {
      const usage = await invoke<number>("cpu_usage");
      const state =
        usage < 10 ? "00" : usage < 50 ? "02" : usage < 80 ? "16" : "21";
      shell.dataset.state = state;
      setEmotion(state);
      if (
        shell.classList.contains("is-processing") ||
        shell.classList.contains("is-success") ||
        shell.classList.contains("is-error")
      ) {
        return;
      }
      status.textContent =
        state === "00"
          ? "浅睡"
          : state === "02"
            ? "清醒"
            : state === "16"
              ? "专注"
              : "过载";
    } catch {
      shell.dataset.state = "awake";
    }
  };
  void updateCpuState();
  window.setInterval(() => void updateCpuState(), 2500);
}

function renderHud(root: HTMLDivElement) {
  root.innerHTML = `
    <main class="hud-shell" id="hud-shell">
      <section class="hud-panel" role="dialog" aria-label="搜索文件">
        <div class="search-row">
          <span class="search-icon" aria-hidden="true">⌕</span>
          <input id="search-input" type="search" autocomplete="off" placeholder="搜索文件名..." />
          <kbd>ESC</kbd>
        </div>
        <div class="result-meta" id="result-meta">输入文件名开始搜索</div>
        <div class="results" id="results" role="listbox"></div>
        <div class="hud-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd>选择</span>
          <span><kbd>Enter</kbd>打开</span>
        </div>
      </section>
    </main>
  `;

  const shell = root.querySelector<HTMLElement>("#hud-shell")!;
  const input = root.querySelector<HTMLInputElement>("#search-input")!;
  const results = root.querySelector<HTMLDivElement>("#results")!;
  const meta = root.querySelector<HTMLDivElement>("#result-meta")!;
  let currentResults: SearchResult[] = [];
  let selectedIndex = 0;
  let debounceTimer: number | undefined;
  let searchGeneration = 0;

  const showRecent = () => {
    currentResults = readRecent();
    selectedIndex = 0;
    meta.textContent = currentResults.length ? "最近打开" : "暂无最近打开的文件";
    paintResults();
  };

  const hide = async () => {
    await invoke("hide_hud");
  };

  const openSelected = async () => {
    const result = currentResults[selectedIndex];
    if (!result) {
      return;
    }
    try {
      await invoke("open_path", { path: result.path, kind: result.kind });
      rememberRecent(result);
      await hide();
    } catch (error) {
      meta.textContent = String(error);
    }
  };

  const paintResults = () => {
    results.innerHTML = currentResults
      .map(
        (result, index) => `
          <button class="result-item ${index === selectedIndex ? "is-selected" : ""}" data-index="${index}" role="option">
            <span class="result-kind">${result.kind === "folder" ? "▰" : "▱"}</span>
            <span class="result-copy">
              <strong>${escapeHtml(result.name)}</strong>
              <small>${escapeHtml(result.path)}</small>
            </span>
          </button>
        `,
      )
      .join("");
    results.querySelectorAll<HTMLButtonElement>(".result-item").forEach((item) => {
      item.addEventListener("click", () => {
        selectedIndex = Number(item.dataset.index);
        openSelected();
      });
    });
  };

  const search = async () => {
    const query = input.value.trim();
    if (!query) {
      showRecent();
      return;
    }
    meta.textContent = "正在搜索...";
    const generation = ++searchGeneration;
    try {
      const nextResults = await invoke<SearchResult[]>("search_files", { query });
      if (generation !== searchGeneration) {
        return;
      }
      currentResults = nextResults;
      selectedIndex = 0;
      meta.textContent = currentResults.length
        ? `${currentResults.length} 个结果`
        : "没有找到匹配文件";
      paintResults();
    } catch (error) {
      currentResults = [];
      meta.textContent = String(error);
      paintResults();
    }
  };

  input.addEventListener("input", () => {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => void search(), 160);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void hide();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
      paintResults();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      paintResults();
    } else if (event.key === "Enter") {
      event.preventDefault();
      openSelected();
    }
  });

  shell.addEventListener("click", (event) => {
    if (event.target === shell) {
      void hide();
    }
  });
  void listen("global-hotkey", () => {
    input.focus();
    input.select();
    showRecent();
  });
  void listen("hud-opened", () => {
    input.focus();
    input.select();
    showRecent();
  });
}

type RemoteEntry = {
  name: string;
  path: string;
  kind: "file" | "folder";
  size: number;
  modified?: number;
};

type SshPrepare = {
  attemptId: string;
  host: string;
  port: number;
  username: string;
  fingerprint: string;
  authMethods: string[];
  trusted: boolean;
};

type SftpTransferEvent = {
  kind?: "upload" | "download";
  status?: string;
  path?: string;
  paths?: string[];
  transferredBytes?: number;
  totalBytes?: number;
  error?: string;
  failures?: string[];
};

function renderRemote(root: HTMLDivElement) {
  root.innerHTML = `
    <main class="remote-shell">
      <section class="remote-panel" aria-label="SSH 远端文件">
        <header class="remote-header">
          <div><strong>Goki SSH</strong><span id="remote-connection-label">未连接</span></div>
          <button class="remote-button remote-disconnect" id="remote-disconnect" hidden>断开</button>
        </header>
        <section class="remote-connect" id="remote-connect">
          <form id="ssh-form">
            <label for="ssh-target">连接地址</label>
            <input id="ssh-target" autocomplete="off" placeholder="user@host[:port]" required />
            <button class="remote-button" type="submit">连接</button>
          </form>
          <div class="remote-status" id="ssh-status">输入 SSH 地址开始连接</div>
          <div class="ssh-trust" id="ssh-trust" hidden>
            <strong>主机指纹</strong>
            <code id="ssh-fingerprint"></code>
            <p>首次连接请确认这个指纹来自可信服务器。</p>
            <button class="remote-button" id="ssh-trust-button" type="button">信任并继续</button>
          </div>
          <form id="ssh-password-form" hidden>
            <label for="ssh-password">密码</label>
            <input id="ssh-password" type="password" autocomplete="current-password" required />
            <button class="remote-button" type="submit">登录</button>
          </form>
        </section>
        <section class="remote-explorer" id="remote-explorer" hidden>
          <div class="remote-toolbar">
            <button class="remote-icon-button" id="remote-up" title="返回上级目录" type="button">↑</button>
            <code id="remote-path">/</code>
            <button class="remote-icon-button" id="remote-new-dir" title="新建目录" type="button">＋</button>
            <button class="remote-icon-button" id="remote-rename" title="重命名选中项" type="button">✎</button>
            <button class="remote-icon-button" id="remote-delete" title="删除选中项" type="button">×</button>
            <button class="remote-icon-button" id="remote-refresh" title="刷新目录" type="button">↻</button>
          </div>
          <div class="remote-list" id="remote-list" role="listbox" aria-label="远程文件"></div>
          <div class="remote-status" id="remote-status">就绪</div>
          <div class="remote-transfer" id="remote-transfer" aria-live="polite" hidden></div>
        </section>
      </section>
    </main>
  `;

  const connectSection = root.querySelector<HTMLElement>("#remote-connect")!;
  const explorer = root.querySelector<HTMLElement>("#remote-explorer")!;
  const form = root.querySelector<HTMLFormElement>("#ssh-form")!;
  const targetInput = root.querySelector<HTMLInputElement>("#ssh-target")!;
  const passwordForm = root.querySelector<HTMLFormElement>("#ssh-password-form")!;
  const passwordInput = root.querySelector<HTMLInputElement>("#ssh-password")!;
  const trustBox = root.querySelector<HTMLElement>("#ssh-trust")!;
  const fingerprint = root.querySelector<HTMLElement>("#ssh-fingerprint")!;
  const trustButton = root.querySelector<HTMLButtonElement>("#ssh-trust-button")!;
  const status = root.querySelector<HTMLElement>("#ssh-status")!;
  const remoteStatus = root.querySelector<HTMLElement>("#remote-status")!;
  const transferStatus = root.querySelector<HTMLElement>("#remote-transfer")!;
  const list = root.querySelector<HTMLElement>("#remote-list")!;
  const pathLabel = root.querySelector<HTMLElement>("#remote-path")!;
  const connectionLabel = root.querySelector<HTMLElement>("#remote-connection-label")!;
  const disconnect = root.querySelector<HTMLButtonElement>("#remote-disconnect")!;
  const up = root.querySelector<HTMLButtonElement>("#remote-up")!;
  const refresh = root.querySelector<HTMLButtonElement>("#remote-refresh")!;
  const newDir = root.querySelector<HTMLButtonElement>("#remote-new-dir")!;
  const rename = root.querySelector<HTMLButtonElement>("#remote-rename")!;
  const remove = root.querySelector<HTMLButtonElement>("#remote-delete")!;
  let attempt: SshPrepare | undefined;
  let sessionId: string | undefined;
  let currentPath = "/";
  let loadingDirectory = false;
  let selectedEntry: { path: string; name: string; kind: "file" | "folder" } | undefined;
  const activeDownloads = new Set<string>();

  const showError = (message: unknown) => {
    status.textContent = String(message);
    remoteStatus.textContent = String(message);
  };

  const loadDirectory = async (path: string) => {
    if (!sessionId || loadingDirectory) return;
    loadingDirectory = true;
    up.disabled = true;
    refresh.disabled = true;
    remoteStatus.textContent = "正在读取目录...";
    try {
      const entries = await invoke<RemoteEntry[]>("ssh_list", { sessionId, path });
      currentPath = path;
      selectedEntry = undefined;
      pathLabel.textContent = path;
      list.innerHTML = entries.length ? entries.map((entry) => `
        <div class="remote-entry ${entry.kind}" data-path="${escapeHtml(entry.path)}" data-kind="${entry.kind}" role="option" tabindex="0" aria-label="${escapeHtml(entry.name)}">
          <span class="remote-entry-icon">${entry.kind === "folder" ? "▸" : "•"}</span>
          <span class="remote-entry-name">${escapeHtml(entry.name)}</span>
          <small>${entry.kind === "folder" ? "文件夹" : formatBytes(entry.size)}</small>
          ${entry.kind === "file" ? `<button class="remote-entry-action" type="button" title="下载 ${escapeHtml(entry.name)}" aria-label="下载 ${escapeHtml(entry.name)}">↓</button>` : ""}
        </div>`).join("") : `<div class="remote-empty">此目录为空</div>`;
      list.querySelectorAll<HTMLElement>(".remote-entry").forEach((entry) => {
        const activate = () => {
          entry.focus();
          list.querySelectorAll(".remote-entry.is-selected").forEach((item) => item.classList.remove("is-selected"));
          entry.classList.add("is-selected");
          selectedEntry = {
            path: entry.dataset.path!,
            name: entry.querySelector<HTMLElement>(".remote-entry-name")?.textContent ?? "",
            kind: entry.dataset.kind as "file" | "folder",
          };
        };
        entry.addEventListener("click", (event) => {
          if ((event.target as HTMLElement).closest(".remote-entry-action")) return;
          activate();
        });
        entry.addEventListener("dblclick", () => {
          const entryPath = entry.dataset.path!;
          if (entry.dataset.kind === "folder") void loadDirectory(entryPath);
          else void download(entryPath);
        });
        entry.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            const entryPath = entry.dataset.path!;
            if (event.key === "Enter" && entry.dataset.kind === "folder") void loadDirectory(entryPath);
            else if (event.key === "Enter") void download(entryPath);
            else activate();
          }
        });
        entry.querySelector<HTMLButtonElement>(".remote-entry-action")?.addEventListener("click", (event) => {
          event.stopPropagation();
          void download(entry.dataset.path!);
        });
      });
      remoteStatus.textContent = `${entries.length} 个项目`;
    } catch (error) {
      remoteStatus.textContent = String(error);
    } finally {
      loadingDirectory = false;
      refresh.disabled = false;
      up.disabled = currentPath === "/";
    }
  };

  const download = async (path: string) => {
    if (!sessionId || activeDownloads.has(path)) return;
    activeDownloads.add(path);
    remoteStatus.textContent = "正在下载...";
    transferStatus.hidden = false;
    transferStatus.textContent = `准备下载 ${path.split("/").filter(Boolean).pop() ?? "文件"}`;
    try {
      const fileName = path.split("/").filter(Boolean).pop() ?? "download";
      const selectedPath = await save({
        defaultPath: fileName,
        title: "选择下载位置",
      });
      if (!selectedPath) {
        remoteStatus.textContent = "已取消下载";
        return;
      }
      const localPath = await invoke<string>("ssh_download", { sessionId, remotePath: path, localPath: selectedPath });
      remoteStatus.textContent = `已下载到 ${localPath}`;
    } catch (error) {
      remoteStatus.textContent = String(error);
    } finally {
      activeDownloads.delete(path);
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "正在等待远端响应...";
    try {
      attempt = await invoke<SshPrepare>("ssh_prepare", { target: targetInput.value });
      fingerprint.textContent = `SHA256:${attempt.fingerprint}`;
      trustBox.hidden = attempt.trusted;
      passwordForm.hidden = !attempt.trusted;
      status.textContent = attempt.trusted ? "主机已信任，请输入密码" : "请确认主机指纹后继续";
      if (attempt.trusted) passwordInput.focus();
    } catch (error) {
      showError(error);
    }
  });

  trustButton.addEventListener("click", async () => {
    if (!attempt) return;
    try {
      await invoke("ssh_trust", { attemptId: attempt.attemptId });
      trustBox.hidden = true;
      passwordForm.hidden = false;
      status.textContent = "主机已信任，请输入密码";
      passwordInput.focus();
    } catch (error) {
      showError(error);
    }
  });

  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!attempt) return;
    status.textContent = "正在认证...";
    try {
      const result = await invoke<{ sessionId: string; host: string; cwd: string }>("ssh_authenticate", {
        attemptId: attempt.attemptId,
        password: passwordInput.value,
      });
      passwordInput.value = "";
      sessionId = result.sessionId;
      currentPath = result.cwd;
      connectionLabel.textContent = `${attempt.username}@${result.host}`;
      connectSection.hidden = true;
      explorer.hidden = false;
      disconnect.hidden = false;
      await loadDirectory(currentPath);
    } catch (error) {
      passwordInput.value = "";
      showError(error);
    }
  });

  const closeSession = async () => {
    if (sessionId) await invoke("ssh_disconnect", { sessionId }).catch(() => undefined);
    sessionId = undefined;
    attempt = undefined;
    explorer.hidden = true;
    connectSection.hidden = false;
    disconnect.hidden = true;
    connectionLabel.textContent = "未连接";
    status.textContent = "已断开连接";
  };
  disconnect.addEventListener("click", () => void closeSession());
  refresh.addEventListener("click", () => void loadDirectory(currentPath));
  newDir.addEventListener("click", async () => {
    if (!sessionId) return;
    const name = window.prompt("新建远程目录名称");
    if (!name?.trim()) return;
    try {
      await invoke("ssh_mkdir", { sessionId, path: remoteJoinPath(currentPath, name.trim()) });
      await loadDirectory(currentPath);
    } catch (error) { remoteStatus.textContent = String(error); }
  });
  rename.addEventListener("click", async () => {
    if (!sessionId || !selectedEntry) return;
    const name = window.prompt("输入新名称", selectedEntry.name);
    if (!name?.trim() || name.trim() === selectedEntry.name) return;
    try {
      await invoke("ssh_rename", { sessionId, from: selectedEntry.path, to: remoteJoinPath(currentPath, name.trim()) });
      await loadDirectory(currentPath);
    } catch (error) { remoteStatus.textContent = String(error); }
  });
  remove.addEventListener("click", async () => {
    if (!sessionId || !selectedEntry) return;
    if (!window.confirm(`确认删除 ${selectedEntry.name}？空目录可以删除，非空目录会失败。`)) return;
    try {
      await invoke("ssh_delete", { sessionId, path: selectedEntry.path });
      await loadDirectory(currentPath);
    } catch (error) { remoteStatus.textContent = String(error); }
  });
  up.addEventListener("click", () => {
    if (currentPath === "/") return;
    const parent = currentPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
    void loadDirectory(parent);
  });

  void listen<SftpTransferEvent>("sftp-transfer", (event) => {
    const payload = event.payload ?? {};
    const transferred = payload.transferredBytes;
    const total = payload.totalBytes;
    const progress = typeof transferred === "number" && typeof total === "number" && total > 0
      ? ` (${Math.round(transferred / total * 100)}%)`
      : "";
    transferStatus.hidden = false;
    if (payload.error || payload.status === "error" || payload.status === "failed") {
      transferStatus.textContent = `${payload.kind === "upload" ? "上传" : "下载"}失败：${payload.error ?? "未知错误"}`;
    } else if (payload.status === "completed") {
      const failedCount = payload.failures?.length ?? 0;
      transferStatus.textContent = payload.kind === "upload"
        ? `上传完成${failedCount ? `，失败 ${failedCount} 个` : ""}`
        : `下载完成${payload.path ? `：${payload.path}` : ""}`;
    } else {
      transferStatus.textContent = `${payload.kind === "upload" ? "上传中" : "下载中"}${progress}`;
    }
  });

  void listen<DragPayload>("tauri://drag-over", () => root.classList.add("is-dragging"));
  void listen("tauri://drag-leave", () => root.classList.remove("is-dragging"));
  void listen<DragPayload>("tauri://drag-drop", async (event) => {
    root.classList.remove("is-dragging");
    if (!sessionId || !(event.payload.paths?.length)) return;
    remoteStatus.textContent = "正在上传...";
    transferStatus.hidden = false;
    transferStatus.textContent = `正在处理 ${event.payload.paths.length} 个项目...`;
    try {
      const uploaded = await invoke<string[]>("ssh_upload", { sessionId, localPaths: event.payload.paths, remoteDir: currentPath });
      const skipped = event.payload.paths.length - uploaded.length;
      remoteStatus.textContent = skipped > 0
        ? `已上传 ${uploaded.length} 个文件，跳过 ${skipped} 个目录或无效项目`
        : `已上传 ${uploaded.length} 个文件`;
      transferStatus.textContent = remoteStatus.textContent;
      await loadDirectory(currentPath);
    } catch (error) {
      remoteStatus.textContent = String(error);
    }
  });
}

function remoteJoinPath(directory: string, name: string) {
  const base = directory.trim().replace(/\/+$/, "") || "/";
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function readRecent(): SearchResult[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter((item): item is SearchResult =>
      item && typeof item.name === "string" && typeof item.path === "string" &&
      (item.kind === "file" || item.kind === "folder"),
    );
  } catch {
    return [];
  }
}

function rememberRecent(result: SearchResult) {
  const next = [result, ...readRecent().filter((item) => item.path !== result.path)]
    .slice(0, MAX_RECENT_FILES);
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable in restricted webview contexts.
  }
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character]!,
  );
}
