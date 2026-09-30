import type { SearchResult } from "./types";

const RECENT_FILES_KEY = "goki.recent-files";
const MAX_RECENT_FILES = 8;

export function readRecent(): SearchResult[] {
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

export function rememberRecent(result: SearchResult) {
  const next = [result, ...readRecent().filter((item) => item.path !== result.path)]
    .slice(0, MAX_RECENT_FILES);
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable in restricted webview contexts.
  }
}
