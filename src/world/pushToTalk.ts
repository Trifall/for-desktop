import { contextBridge, ipcRenderer } from "electron";

// Store callbacks for cleanup
const stateChangeCallbacks = new Set<(state: { active: boolean }) => void>();
let currentPttState = false;

// Debug logging
function pttLog(...args: unknown[]) {
  console.log("[PTT-Renderer]", ...args);
}

// Listen for PTT state changes from main process
ipcRenderer.on("push-to-talk", (_event, state: { active: boolean }) => {
  pttLog("Received PTT state from main:", state.active ? "ON" : "OFF");

  // Only update if different from current state
  if (currentPttState !== state.active) {
    currentPttState = state.active;
    stateChangeCallbacks.forEach((cb) => {
      try {
        cb(state);
      } catch (err) {
        console.error("[PTT] Error in callback:", err);
      }
    });
  }
});

// Expose API to renderer/world
contextBridge.exposeInMainWorld("pushToTalk", {
  /**
   * Subscribe to PTT state changes
   */
  onStateChange: (callback: (state: { active: boolean }) => void) => {
    stateChangeCallbacks.add(callback);
    pttLog("Listener added. Current state:", currentPttState ? "ON" : "OFF");

    // Immediately call with current state
    callback({ active: currentPttState });
  },

  /**
   * Unsubscribe from PTT state changes
   */
  offStateChange: (callback: (state: { active: boolean }) => void) => {
    stateChangeCallbacks.delete(callback);
    pttLog("Listener removed");
  },

  /**
   * Manually set PTT state (for UI buttons, etc.)
   */
  setManualState: (active: boolean) => {
    pttLog("Manual state set:", active);
    ipcRenderer.send("push-to-talk-manual", { active });
    currentPttState = active;
    stateChangeCallbacks.forEach((cb) => {
      try {
        cb({ active });
      } catch (err) {
        console.error("[PTT] Error in callback:", err);
      }
    });
  },

  /**
   * Get current PTT state
   */
  getCurrentState: () => {
    return { active: currentPttState };
  },

  /**
   * Check if PTT API is available
   */
  isAvailable: () => true,
});

pttLog(
  "Preload script loaded (simplified - using main process before-input-event)",
);
