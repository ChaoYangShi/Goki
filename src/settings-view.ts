import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { DEFAULT_THEME, readTheme, saveTheme, type ThemeSettings } from "./theme";

export function renderSettings(root: HTMLDivElement) {
  const theme = readTheme();
  root.innerHTML = `
    <main class="settings-shell">
      <section class="settings-panel" aria-label="外观设置">
        <header class="settings-header">
          <div><strong>外观设置</strong><span>自定义 Goki 的颜色</span></div>
          <button class="settings-close" id="settings-close" type="button" aria-label="关闭">×</button>
        </header>
        <form class="settings-form" id="theme-form">
          <div class="settings-field"><span>强调色</span><input id="theme-accent" type="color" value="${theme.accent}" /></div>
          <div class="settings-field"><span>小球颜色</span><input id="theme-pet" type="color" value="${theme.petColor}" /></div>
          <div class="settings-field"><span>眼睛颜色</span><input id="theme-eye" type="color" value="${theme.eyeColor}" /></div>
          <div class="settings-actions">
            <button type="button" id="theme-reset">恢复默认</button>
            <button class="settings-primary" type="submit">保存</button>
          </div>
          <div class="settings-status" id="settings-status" aria-live="polite"></div>
        </form>
      </section>
    </main>
  `;
  const form = root.querySelector<HTMLFormElement>("#theme-form")!;
  const status = root.querySelector<HTMLElement>("#settings-status")!;
  const accent = root.querySelector<HTMLInputElement>("#theme-accent")!;
  const pet = root.querySelector<HTMLInputElement>("#theme-pet")!;
  const eye = root.querySelector<HTMLInputElement>("#theme-eye")!;
  root.querySelector<HTMLButtonElement>("#settings-close")!.addEventListener("click", () => void invoke("hide_settings"));
  root.querySelector<HTMLButtonElement>("#theme-reset")!.addEventListener("click", () => {
    setInputs(DEFAULT_THEME);
    status.textContent = "已恢复默认值，点击保存生效";
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saved = saveTheme({ accent: accent.value, petColor: pet.value, eyeColor: eye.value });
    try {
      await emit("theme-changed", saved);
      status.textContent = "已保存";
    } catch (error) {
      status.textContent = `已保存本地设置，但同步失败：${String(error)}`;
    }
  });
  function setInputs(value: ThemeSettings) {
    accent.value = value.accent;
    pet.value = value.petColor;
    eye.value = value.eyeColor;
  }
}
