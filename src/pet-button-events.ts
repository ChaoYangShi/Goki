import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  ready: boolean;
  moved: boolean;
  nativeStarted: boolean;
};

type PetButtonContext = {
  button: HTMLButtonElement;
  ballMount: HTMLElement;
  status: HTMLElement;
};

export function bindPetButtonEvents({ button, ballMount, status }: PetButtonContext) {
  const currentWindow = getCurrentWindow();
  let zoom = 1;
  let suppressClick = false;
  let dragging: DragState | undefined;

  button.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom = Math.min(1.55, Math.max(0.65, zoom + (event.deltaY < 0 ? 0.08 : -0.08)));
    ballMount.style.transform = `scale(${zoom})`;
  }, { passive: false });

  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    button.setPointerCapture(event.pointerId);
    if (!button.hasPointerCapture(event.pointerId)) return;
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
    if (!dragging?.ready || dragging.pointerId !== event.pointerId || event.buttons !== 1) return;
    const dx = event.clientX - dragging.startX;
    const dy = event.clientY - dragging.startY;
    if (Math.abs(dx) + Math.abs(dy) < 2) return;
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
    if (dragging?.pointerId === event.pointerId) dragging = undefined;
    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
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

  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void invoke("show_ssh_menu").catch((error) => {
      console.error("Unable to show SSH menu", error);
      status.textContent = String(error);
      status.classList.add("is-visible");
    });
  });
}
