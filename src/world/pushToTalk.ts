import { contextBridge, ipcRenderer } from "electron";

// Store callbacks for cleanup
const stateChangeCallbacks = new Map<
  (state: { active: boolean }) => void,
  (event: Electron.IpcRendererEvent, state: { active: boolean }) => void
>();
const localKeybindCallbacks = new Map<
  (data: { accelerator: string }) => void,
  (event: Electron.IpcRendererEvent, data: { accelerator: string }) => void
>();

// Track current PTT state
let currentPttState = false;

// Global debug listener - logs all PTT events
ipcRenderer.on("push-to-talk", (_event, state: { active: boolean }) => {
  console.log(
    "[PTT-RENDERER] Global listener received state:",
    state.active ? "ON" : "OFF",
  );
  currentPttState = state.active;
});

// Push-to-talk IPC - exposed to renderer process
contextBridge.exposeInMainWorld("pushToTalk", {
  onStateChange: (callback: (state: { active: boolean }) => void) => {
    // Prevent duplicate registrations
    if (stateChangeCallbacks.has(callback)) {
      console.warn(
        "[PTT] onStateChange callback already registered, ignoring duplicate",
      );
      return;
    }
    const wrappedCallback = (
      _event: Electron.IpcRendererEvent,
      state: { active: boolean },
    ) => {
      console.log(
        "[PTT-RENDERER] Wrapped callback received state:",
        state.active ? "ON" : "OFF",
      );
      currentPttState = state.active;
      callback(state);
    };
    stateChangeCallbacks.set(callback, wrappedCallback);
    ipcRenderer.on("push-to-talk", wrappedCallback);
    console.log(
      "[PTT-RENDERER] Listener registered, current state:",
      currentPttState ? "ON" : "OFF",
    );
  },
  offStateChange: (callback: (state: { active: boolean }) => void) => {
    const wrappedCallback = stateChangeCallbacks.get(callback);
    if (wrappedCallback) {
      ipcRenderer.removeListener("push-to-talk", wrappedCallback);
      stateChangeCallbacks.delete(callback);
      console.log("[PTT-RENDERER] Listener removed");
    }
  },
  onLocalKeybind: (callback: (data: { accelerator: string }) => void) => {
    // Prevent duplicate registrations
    if (localKeybindCallbacks.has(callback)) {
      console.warn(
        "[PTT] onLocalKeybind callback already registered, ignoring duplicate",
      );
      return;
    }
    const wrappedCallback = (
      _event: Electron.IpcRendererEvent,
      data: { accelerator: string },
    ) => callback(data);
    localKeybindCallbacks.set(callback, wrappedCallback);
    ipcRenderer.on("push-to-talk-local", wrappedCallback);
  },
  offLocalKeybind: (callback: (data: { accelerator: string }) => void) => {
    const wrappedCallback = localKeybindCallbacks.get(callback);
    if (wrappedCallback) {
      ipcRenderer.removeListener("push-to-talk-local", wrappedCallback);
      localKeybindCallbacks.delete(callback);
    }
  },
  setManualState: (active: boolean) => {
    ipcRenderer.send("push-to-talk-manual", { active });
  },
  // Get current PTT state
  getCurrentState: () => {
    return { active: currentPttState };
  },
});
