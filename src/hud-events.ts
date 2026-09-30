import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SearchResult } from "./types";

type HudEventContext = {
  shell: HTMLElement;
  input: HTMLInputElement;
  paintResults: () => void;
  search: () => Promise<void>;
  showRecent: () => void;
  openSelected: () => Promise<void>;
  getResults: () => SearchResult[];
  getSelectedIndex: () => number;
  setSelectedIndex: (index: number) => void;
};

export function bindHudEvents({
  shell,
  input,
  paintResults,
  search,
  showRecent,
  openSelected,
  getResults,
  getSelectedIndex,
  setSelectedIndex,
}: HudEventContext) {
  let debounceTimer: number | undefined;

  input.addEventListener("input", () => {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => void search(), 160);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void invoke("hide_hud");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex(Math.min(getSelectedIndex() + 1, getResults().length - 1));
      paintResults();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex(Math.max(getSelectedIndex() - 1, 0));
      paintResults();
    } else if (event.key === "Enter") {
      event.preventDefault();
      void openSelected();
    }
  });

  shell.addEventListener("click", (event) => {
    if (event.target === shell) void invoke("hide_hud");
  });

  const focusAndShowRecent = () => {
    input.focus();
    input.select();
    showRecent();
  };
  void listen("global-hotkey", focusAndShowRecent);
  void listen("hud-opened", focusAndShowRecent);
}
