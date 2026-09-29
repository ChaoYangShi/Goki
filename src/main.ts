import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
