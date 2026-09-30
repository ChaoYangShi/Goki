type RemoteButtonContext = {
  disconnect: HTMLButtonElement;
  refresh: HTMLButtonElement;
  newDir: HTMLButtonElement;
  rename: HTMLButtonElement;
  remove: HTMLButtonElement;
  up: HTMLButtonElement;
  onDisconnect: () => void;
  onRefresh: () => void;
  onNewDir: () => void;
  onRename: () => void;
  onRemove: () => void;
  onUp: () => void;
};

export function bindRemoteButtonEvents({
  disconnect,
  refresh,
  newDir,
  rename,
  remove,
  up,
  onDisconnect,
  onRefresh,
  onNewDir,
  onRename,
  onRemove,
  onUp,
}: RemoteButtonContext) {
  disconnect.addEventListener("click", onDisconnect);
  refresh.addEventListener("click", onRefresh);
  newDir.addEventListener("click", onNewDir);
  rename.addEventListener("click", onRename);
  remove.addEventListener("click", onRemove);
  up.addEventListener("click", onUp);
}
