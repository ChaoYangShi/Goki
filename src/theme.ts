export type ThemeSettings = {
  accent: string;
  petColor: string;
  eyeColor: string;
};

export const DEFAULT_THEME: ThemeSettings = {
  accent: "#84eefb",
  petColor: "#15191d",
  eyeColor: "#f4f4f4",
};

const THEME_KEY = "goki.theme";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function readTheme(): ThemeSettings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(THEME_KEY) ?? "null");
    if (!value || typeof value !== "object") return DEFAULT_THEME;
    const candidate = value as Partial<ThemeSettings>;
    return {
      accent: validColor(candidate.accent) ? candidate.accent! : DEFAULT_THEME.accent,
      petColor: validColor(candidate.petColor) ? candidate.petColor! : DEFAULT_THEME.petColor,
      eyeColor: validColor(candidate.eyeColor) ? candidate.eyeColor! : DEFAULT_THEME.eyeColor,
    };
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveTheme(theme: ThemeSettings) {
  const normalized: ThemeSettings = {
    accent: validColor(theme.accent) ? theme.accent : DEFAULT_THEME.accent,
    petColor: validColor(theme.petColor) ? theme.petColor : DEFAULT_THEME.petColor,
    eyeColor: validColor(theme.eyeColor) ? theme.eyeColor : DEFAULT_THEME.eyeColor,
  };
  try { localStorage.setItem(THEME_KEY, JSON.stringify(normalized)); } catch { /* restricted storage */ }
  applyTheme(normalized);
  return normalized;
}

export function applyTheme(theme: ThemeSettings) {
  const root = document.documentElement;
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--pet-color", theme.petColor);
  root.style.setProperty("--eye-color", theme.eyeColor);
}

export function validColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}
