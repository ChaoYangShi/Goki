import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";
import type { DragPayload, SearchResult } from "./types";
import { readRecent, rememberRecent } from "./recent";
import { escapeHtml } from "./ui-utils";
import { bindPetButtonEvents } from "./pet-button-events";
import { bindHudEvents } from "./hud-events";
import { RemoteController } from "./remote-controller";
import { renderSettings } from "./settings-view";
import { applyTheme, readTheme, type ThemeSettings } from "./theme";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Goki root element is missing");
}

applyTheme(readTheme());
void listen<ThemeSettings>("theme-changed", (event) => applyTheme(event.payload));

const currentWindow = getCurrentWindow();
if (currentWindow.label === "hud") {
  renderHud(app);
} else if (currentWindow.label === "remote") {
  renderRemote(app);
} else if (currentWindow.label === "settings") {
  renderSettings(app);
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
  const theme = readTheme();
  const ball = window.GrokBall?.create(ballMount, {
    emotion: "02",
    color: theme.petColor,
    eyeColor: theme.eyeColor,
    shape: "blob",
    label: "Goki",
    idle: false,
  });
  void listen<ThemeSettings>("theme-changed", (event) => {
    applyTheme(event.payload);
    ball?.setTheme(event.payload.petColor, event.payload.eyeColor);
  });
  const setEmotion = (emotion: string) => {
    ball?.setEmotion(emotion);
  };
  bindPetButtonEvents({ button, ballMount, status });

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

  bindHudEvents({
    shell,
    input,
    paintResults,
    search,
    showRecent,
    openSelected,
    getResults: () => currentResults,
    getSelectedIndex: () => selectedIndex,
    setSelectedIndex: (index) => { selectedIndex = index; },
  });
}

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

  new RemoteController(root).mount();
}
