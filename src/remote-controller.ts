import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { bindRemoteButtonEvents } from "./remote-events";
import type { DragPayload, RemoteEntry, SftpTransferEvent, SshPrepare } from "./types";
import { escapeHtml, formatBytes, remoteJoinPath } from "./ui-utils";

type SelectedEntry = Pick<RemoteEntry, "path" | "name" | "kind">;

export class RemoteController {
  private readonly root: HTMLElement;
  private readonly connectSection: HTMLElement;
  private readonly explorer: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly targetInput: HTMLInputElement;
  private readonly passwordForm: HTMLFormElement;
  private readonly passwordInput: HTMLInputElement;
  private readonly trustBox: HTMLElement;
  private readonly fingerprint: HTMLElement;
  private readonly trustButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly remoteStatus: HTMLElement;
  private readonly transferStatus: HTMLElement;
  private readonly list: HTMLElement;
  private readonly pathLabel: HTMLElement;
  private readonly connectionLabel: HTMLElement;
  private readonly disconnect: HTMLButtonElement;
  private readonly up: HTMLButtonElement;
  private readonly refresh: HTMLButtonElement;
  private readonly newDir: HTMLButtonElement;
  private readonly rename: HTMLButtonElement;
  private readonly remove: HTMLButtonElement;

  private attempt?: SshPrepare;
  private sessionId?: string;
  private currentPath = "/";
  private loadingDirectory = false;
  private selectedEntry?: SelectedEntry;
  private readonly activeDownloads = new Set<string>();

  constructor(root: HTMLElement) {
    this.root = root;
    this.connectSection = this.query("#remote-connect");
    this.explorer = this.query("#remote-explorer");
    this.form = this.query("#ssh-form");
    this.targetInput = this.query("#ssh-target");
    this.passwordForm = this.query("#ssh-password-form");
    this.passwordInput = this.query("#ssh-password");
    this.trustBox = this.query("#ssh-trust");
    this.fingerprint = this.query("#ssh-fingerprint");
    this.trustButton = this.query("#ssh-trust-button");
    this.status = this.query("#ssh-status");
    this.remoteStatus = this.query("#remote-status");
    this.transferStatus = this.query("#remote-transfer");
    this.list = this.query("#remote-list");
    this.pathLabel = this.query("#remote-path");
    this.connectionLabel = this.query("#remote-connection-label");
    this.disconnect = this.query("#remote-disconnect");
    this.up = this.query("#remote-up");
    this.refresh = this.query("#remote-refresh");
    this.newDir = this.query("#remote-new-dir");
    this.rename = this.query("#remote-rename");
    this.remove = this.query("#remote-delete");
  }

  mount() {
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.prepareConnection();
    });
    this.trustButton.addEventListener("click", () => void this.trustHost());
    this.passwordForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.authenticate();
    });
    bindRemoteButtonEvents({
      disconnect: this.disconnect,
      refresh: this.refresh,
      newDir: this.newDir,
      rename: this.rename,
      remove: this.remove,
      up: this.up,
      onDisconnect: () => void this.closeSession(),
      onRefresh: () => void this.loadDirectory(this.currentPath),
      onNewDir: () => void this.createDirectory(),
      onRename: () => void this.renameSelected(),
      onRemove: () => void this.deleteSelected(),
      onUp: () => void this.loadParentDirectory(),
    });
    this.bindTransferEvents();
    this.bindDropEvents();
  }

  private query<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`远程窗口缺少元素: ${selector}`);
    return element;
  }

  private showError(message: unknown) {
    this.status.textContent = String(message);
    this.remoteStatus.textContent = String(message);
  }

  private async prepareConnection() {
    this.status.textContent = "正在等待远端响应...";
    try {
      this.attempt = await invoke<SshPrepare>("ssh_prepare", { target: this.targetInput.value });
      this.fingerprint.textContent = `SHA256:${this.attempt.fingerprint}`;
      this.trustBox.hidden = this.attempt.trusted;
      this.passwordForm.hidden = !this.attempt.trusted;
      this.status.textContent = this.attempt.trusted ? "主机已信任，请输入密码" : "请确认主机指纹后继续";
      if (this.attempt.trusted) this.passwordInput.focus();
    } catch (error) {
      this.showError(error);
    }
  }

  private async trustHost() {
    if (!this.attempt) return;
    try {
      await invoke("ssh_trust", { attemptId: this.attempt.attemptId });
      this.trustBox.hidden = true;
      this.passwordForm.hidden = false;
      this.status.textContent = "主机已信任，请输入密码";
      this.passwordInput.focus();
    } catch (error) {
      this.showError(error);
    }
  }

  private async authenticate() {
    if (!this.attempt) return;
    this.status.textContent = "正在认证...";
    try {
      const result = await invoke<{ sessionId: string; host: string; cwd: string }>("ssh_authenticate", {
        attemptId: this.attempt.attemptId,
        password: this.passwordInput.value,
      });
      this.passwordInput.value = "";
      this.sessionId = result.sessionId;
      this.currentPath = result.cwd;
      this.connectionLabel.textContent = `${this.attempt.username}@${result.host}`;
      this.connectSection.hidden = true;
      this.explorer.hidden = false;
      this.disconnect.hidden = false;
      await this.loadDirectory(this.currentPath);
    } catch (error) {
      this.passwordInput.value = "";
      this.showError(error);
    }
  }

  private async closeSession() {
    if (this.sessionId) await invoke("ssh_disconnect", { sessionId: this.sessionId }).catch(() => undefined);
    this.sessionId = undefined;
    this.attempt = undefined;
    this.explorer.hidden = true;
    this.connectSection.hidden = false;
    this.disconnect.hidden = true;
    this.connectionLabel.textContent = "未连接";
    this.status.textContent = "已断开连接";
  }

  private async loadDirectory(path: string) {
    if (!this.sessionId || this.loadingDirectory) return;
    this.loadingDirectory = true;
    this.up.disabled = true;
    this.refresh.disabled = true;
    this.remoteStatus.textContent = "正在读取目录...";
    try {
      const entries = await invoke<RemoteEntry[]>("ssh_list", { sessionId: this.sessionId, path });
      this.currentPath = path;
      this.selectedEntry = undefined;
      this.pathLabel.textContent = path;
      this.list.innerHTML = entries.length ? entries.map((entry) => `
        <div class="remote-entry ${entry.kind}" data-path="${escapeHtml(entry.path)}" data-kind="${entry.kind}" role="option" tabindex="0" aria-label="${escapeHtml(entry.name)}">
          <span class="remote-entry-icon">${entry.kind === "folder" ? "▸" : "•"}</span>
          <span class="remote-entry-name">${escapeHtml(entry.name)}</span>
          <small>${entry.kind === "folder" ? "文件夹" : formatBytes(entry.size)}</small>
          ${entry.kind === "file" ? `<button class="remote-entry-action" type="button" title="下载 ${escapeHtml(entry.name)}" aria-label="下载 ${escapeHtml(entry.name)}">↓</button>` : ""}
        </div>`).join("") : `<div class="remote-empty">此目录为空</div>`;
      this.bindEntryEvents();
      this.remoteStatus.textContent = `${entries.length} 个项目`;
    } catch (error) {
      this.remoteStatus.textContent = String(error);
    } finally {
      this.loadingDirectory = false;
      this.refresh.disabled = false;
      this.up.disabled = this.currentPath === "/";
    }
  }

  private bindEntryEvents() {
    this.list.querySelectorAll<HTMLElement>(".remote-entry").forEach((entry) => {
      const activate = () => {
        entry.focus();
        this.list.querySelectorAll(".remote-entry.is-selected").forEach((item) => item.classList.remove("is-selected"));
        entry.classList.add("is-selected");
        this.selectedEntry = {
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
        const path = entry.dataset.path!;
        if (entry.dataset.kind === "folder") void this.loadDirectory(path);
        else void this.download(path);
      });
      entry.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        const path = entry.dataset.path!;
        if (event.key === "Enter" && entry.dataset.kind === "folder") void this.loadDirectory(path);
        else if (event.key === "Enter") void this.download(path);
        else activate();
      });
      entry.querySelector<HTMLButtonElement>(".remote-entry-action")?.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.download(entry.dataset.path!);
      });
    });
  }

  private async download(path: string) {
    if (!this.sessionId || this.activeDownloads.has(path)) return;
    this.activeDownloads.add(path);
    this.remoteStatus.textContent = "正在下载...";
    this.transferStatus.hidden = false;
    this.transferStatus.textContent = `准备下载 ${path.split("/").filter(Boolean).pop() ?? "文件"}`;
    try {
      const fileName = path.split("/").filter(Boolean).pop() ?? "download";
      const selectedPath = await save({ defaultPath: fileName, title: "选择下载位置" });
      if (!selectedPath) {
        this.remoteStatus.textContent = "已取消下载";
        return;
      }
      const localPath = await invoke<string>("ssh_download", { sessionId: this.sessionId, remotePath: path, localPath: selectedPath });
      this.remoteStatus.textContent = `已下载到 ${localPath}`;
    } catch (error) {
      this.remoteStatus.textContent = String(error);
    } finally {
      this.activeDownloads.delete(path);
    }
  }

  private async createDirectory() {
    if (!this.sessionId) return;
    const name = window.prompt("新建远程目录名称");
    if (!name?.trim()) return;
    try {
      await invoke("ssh_mkdir", { sessionId: this.sessionId, path: remoteJoinPath(this.currentPath, name.trim()) });
      await this.loadDirectory(this.currentPath);
    } catch (error) { this.remoteStatus.textContent = String(error); }
  }

  private async renameSelected() {
    if (!this.sessionId || !this.selectedEntry) return;
    const name = window.prompt("输入新名称", this.selectedEntry.name);
    if (!name?.trim() || name.trim() === this.selectedEntry.name) return;
    try {
      await invoke("ssh_rename", { sessionId: this.sessionId, from: this.selectedEntry.path, to: remoteJoinPath(this.currentPath, name.trim()) });
      await this.loadDirectory(this.currentPath);
    } catch (error) { this.remoteStatus.textContent = String(error); }
  }

  private async deleteSelected() {
    if (!this.sessionId || !this.selectedEntry) return;
    if (!window.confirm(`确认删除 ${this.selectedEntry.name}？空目录可以删除，非空目录会失败。`)) return;
    try {
      await invoke("ssh_delete", { sessionId: this.sessionId, path: this.selectedEntry.path });
      await this.loadDirectory(this.currentPath);
    } catch (error) { this.remoteStatus.textContent = String(error); }
  }

  private loadParentDirectory() {
    if (this.currentPath === "/") return;
    const parent = this.currentPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
    void this.loadDirectory(parent);
  }

  private bindTransferEvents() {
    void listen<SftpTransferEvent>("sftp-transfer", (event) => {
      const payload = event.payload ?? {};
      const transferred = payload.transferredBytes;
      const total = payload.totalBytes;
      const progress = typeof transferred === "number" && typeof total === "number" && total > 0
        ? ` (${Math.round(transferred / total * 100)}%)` : "";
      this.transferStatus.hidden = false;
      if (payload.error || payload.status === "error" || payload.status === "failed") {
        this.transferStatus.textContent = `${payload.kind === "upload" ? "上传" : "下载"}失败：${payload.error ?? "未知错误"}`;
      } else if (payload.status === "completed") {
        const failedCount = payload.failures?.length ?? 0;
        this.transferStatus.textContent = payload.kind === "upload"
          ? `上传完成${failedCount ? `，失败 ${failedCount} 个` : ""}`
          : `下载完成${payload.path ? `：${payload.path}` : ""}`;
      } else {
        this.transferStatus.textContent = `${payload.kind === "upload" ? "上传中" : "下载中"}${progress}`;
      }
    });
  }

  private bindDropEvents() {
    void listen<DragPayload>("tauri://drag-over", () => this.root.classList.add("is-dragging"));
    void listen("tauri://drag-leave", () => this.root.classList.remove("is-dragging"));
    void listen<DragPayload>("tauri://drag-drop", async (event) => {
      this.root.classList.remove("is-dragging");
      if (!this.sessionId || !(event.payload.paths?.length)) return;
      this.remoteStatus.textContent = "正在上传...";
      this.transferStatus.hidden = false;
      this.transferStatus.textContent = `正在处理 ${event.payload.paths.length} 个项目...`;
      try {
        const uploaded = await invoke<string[]>("ssh_upload", { sessionId: this.sessionId, localPaths: event.payload.paths, remoteDir: this.currentPath });
        const skipped = event.payload.paths.length - uploaded.length;
        this.remoteStatus.textContent = skipped > 0
          ? `已上传 ${uploaded.length} 个文件，跳过 ${skipped} 个目录或无效项目`
          : `已上传 ${uploaded.length} 个文件`;
        this.transferStatus.textContent = this.remoteStatus.textContent;
        await this.loadDirectory(this.currentPath);
      } catch (error) {
        this.remoteStatus.textContent = String(error);
      }
    });
  }
}
