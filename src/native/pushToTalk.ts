import { globalShortcut, ipcMain } from "electron";

import { config } from "./config";
import { mainWindow } from "./window";

// Debug logging helper
function pttLog(...args: unknown[]) {
  console.log("[PTT]", ...args);
}

// Track PTT state
let isPttActive = false;
let registeredAccelerator: string | null = null;

// For before-input-event tracking
let currentKeybind = "";
let keybindModifiers = { ctrl: false, shift: false, alt: false, meta: false };

// For globalShortcut fallback
let holdModeTimeout: NodeJS.Timeout | null = null;
const GLOBAL_HOLD_TIMEOUT_MS = 400; // Longer timeout to avoid initial blip
let lastGlobalTriggerTime = 0;
let lastActivationTime = 0;
const MIN_HOLD_DURATION_MS = 600; // Don't allow deactivation for first 600ms

// Log initial module load
pttLog("Module loaded (using before-input-event)");

/**
 * Send PTT state to renderer safely
 */
function sendPttState(active: boolean) {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    pttLog("Sending PTT state:", active ? "ON" : "OFF");
    mainWindow.webContents.send("push-to-talk", { active });
  }
}

/**
 * Deactivate PTT
 */
function deactivatePtt(reason: string) {
  if (isPttActive) {
    isPttActive = false;
    pttLog("PTT deactivated:", reason);
    sendPttState(false);
  }
  if (holdModeTimeout) {
    clearTimeout(holdModeTimeout);
    holdModeTimeout = null;
  }
}

/**
 * Activate PTT
 */
function activatePtt(reason: string) {
  if (!isPttActive) {
    isPttActive = true;
    pttLog("PTT activated:", reason);
    sendPttState(true);
  }
}

/**
 * Parse accelerator to key and modifiers
 */
function parseAccelerator(accelerator: string) {
  const parts = accelerator
    .toLowerCase()
    .split(/[+-]/)
    .map((p) => p.trim());
  const key = parts.pop() || "";

  return {
    key,
    ctrl: parts.includes("ctrl") || parts.includes("control"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    meta:
      parts.includes("meta") ||
      parts.includes("cmd") ||
      parts.includes("command"),
  };
}

/**
 * Check if input matches our keybind
 */
function matchesKeybind(input: Electron.Input): boolean {
  const keyMatch = input.key.toLowerCase() === currentKeybind.toLowerCase();
  const ctrlMatch = input.control === keybindModifiers.ctrl;
  const shiftMatch = input.shift === keybindModifiers.shift;
  const altMatch = input.alt === keybindModifiers.alt;
  const metaMatch = input.meta === keybindModifiers.meta;

  return keyMatch && ctrlMatch && shiftMatch && altMatch && metaMatch;
}

/**
 * Handle before-input-event from webContents
 * This fires for ALL keyboard input, even when window appears unfocused on XWayland
 */
function handleBeforeInputEvent(event: Electron.Event, input: Electron.Input) {
  // Log ALL key events for debugging
  if (input.key.length === 1 || input.key === "v" || input.key === "V") {
    pttLog(
      "before-input-event: key='" +
        input.key +
        "' type=" +
        input.type +
        " ctrl=" +
        input.control +
        " shift=" +
        input.shift,
    );
  }

  if (!matchesKeybind(input)) {
    return;
  }

  if (!matchesKeybind(input)) {
    return;
  }

  // We matched the keybind!
  pttLog("Keybind matched! Type:", input.type);

  if (config.pushToTalkMode === "hold") {
    if (input.type === "keyDown") {
      // Prevent the key from being typed into the app
      event.preventDefault();
      activatePtt("before-input-event keyDown");
    } else if (input.type === "keyUp") {
      // Key released
      event.preventDefault();
      deactivatePtt("before-input-event keyUp");
    }
  } else {
    // Toggle mode - only respond to keyDown
    if (input.type === "keyDown") {
      event.preventDefault();
      isPttActive = !isPttActive;
      sendPttState(isPttActive);
      pttLog("PTT toggled:", isPttActive ? "ON" : "OFF");
    }
  }
}

/**
 * Register global hotkey using Electron's globalShortcut (fallback)
 */
function registerGlobalHotkey(accelerator: string): boolean {
  pttLog("Registering global hotkey (fallback):", accelerator);

  try {
    // Unregister existing first
    if (registeredAccelerator) {
      globalShortcut.unregister(registeredAccelerator);
    }

    const success = globalShortcut.register(accelerator, () => {
      const now = Date.now();
      const timeSinceLastTrigger = now - lastGlobalTriggerTime;
      lastGlobalTriggerTime = now;

      pttLog(
        "Global hotkey triggered (fallback), delta:",
        timeSinceLastTrigger,
        "ms",
      );

      if (config.pushToTalkMode === "hold") {
        // Hold mode with globalShortcut uses timeout-based approach

        if (!isPttActive) {
          // First activation - start hold mode
          lastActivationTime = now;
          activatePtt("global hotkey");
          pttLog("PTT activated, starting hold mode");
        } else {
          // Re-trigger while active - reset timeout
          pttLog("Re-triggered, resetting timeout");
        }

        // Clear existing timeout
        if (holdModeTimeout) {
          clearTimeout(holdModeTimeout);
        }

        // Set new timeout - but only deactivate if we've held long enough
        holdModeTimeout = setTimeout(() => {
          const holdDuration = Date.now() - lastActivationTime;
          if (holdDuration >= MIN_HOLD_DURATION_MS) {
            deactivatePtt("global timeout");
          } else {
            // Not held long enough yet, extend timeout
            pttLog(
              "Extending timeout (held for",
              holdDuration,
              "ms, need",
              MIN_HOLD_DURATION_MS,
              "ms)",
            );
            if (holdModeTimeout) clearTimeout(holdModeTimeout);
            holdModeTimeout = setTimeout(
              () => {
                deactivatePtt("global timeout extended");
              },
              MIN_HOLD_DURATION_MS - holdDuration + 100,
            );
          }
        }, GLOBAL_HOLD_TIMEOUT_MS);
      } else {
        // Toggle mode
        isPttActive = !isPttActive;
        sendPttState(isPttActive);
        pttLog("PTT toggled:", isPttActive ? "ON" : "OFF");
      }
    });

    if (success) {
      registeredAccelerator = accelerator;
      pttLog("✓ Registered global hotkey:", accelerator);
      return true;
    } else {
      pttLog("✗ Failed to register global hotkey");
      return false;
    }
  } catch (err) {
    pttLog("✗ Error registering hotkey:", err);
    return false;
  }
}

/**
 * Main function to register push-to-talk hotkey
 */
export async function registerPushToTalkHotkey(): Promise<void> {
  pttLog("Registering PTT hotkey...");

  if (!config.pushToTalk) {
    pttLog("PTT disabled in config");
    unregisterPushToTalkHotkey();
    return;
  }

  const accelerator = config.pushToTalkKeybind || "Shift+Space";
  pttLog("Keybind:", accelerator, "Mode:", config.pushToTalkMode);

  // Don't re-register if same
  if (registeredAccelerator === accelerator) {
    return;
  }

  // Unregister existing
  unregisterPushToTalkHotkey();

  // Parse the accelerator for before-input-event matching
  const parsed = parseAccelerator(accelerator);
  currentKeybind = parsed.key;
  keybindModifiers = {
    ctrl: parsed.ctrl,
    shift: parsed.shift,
    alt: parsed.alt,
    meta: parsed.meta,
  };

  pttLog("Parsed keybind:", currentKeybind, "modifiers:", keybindModifiers);

  // Set up before-input-event listener (PRIMARY method)
  // This works on XWayland even when window appears unfocused
  if (mainWindow && !mainWindow.isDestroyed()) {
    pttLog("Setting up before-input-event listener...");

    // Remove any existing listener first to avoid duplicates
    mainWindow.webContents.off("before-input-event", handleBeforeInputEvent);

    // Add the listener
    mainWindow.webContents.on("before-input-event", handleBeforeInputEvent);
    pttLog(
      "✓ before-input-event listener attached. Window focused:",
      mainWindow.isFocused(),
      "| Visible:",
      mainWindow.isVisible(),
    );

    // Debug: Log window focus state periodically
    setInterval(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        pttLog(
          "[DEBUG] Window state - Focused:",
          mainWindow.isFocused(),
          "| Visible:",
          mainWindow.isVisible(),
          "| PTT Active:",
          isPttActive,
        );
      }
    }, 5000);
  } else {
    pttLog("✗ Cannot attach before-input-event listener - window not ready");
  }

  // Also register global hotkey as fallback
  const globalSuccess = registerGlobalHotkey(accelerator);

  if (globalSuccess) {
    pttLog("✓ Global hotkey registered as backup");
  }

  // Send initial state (mic off)
  isPttActive = false;
  sendPttState(false);
  pttLog("✓ PTT initialized (using before-input-event)");
}

/**
 * Unregister all PTT hotkeys
 */
export function unregisterPushToTalkHotkey(): void {
  pttLog("Unregistering PTT hotkey...");

  deactivatePtt("unregister");

  // Remove before-input-event listener
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.off("before-input-event", handleBeforeInputEvent);
    pttLog("Removed before-input-event listener");
  }

  if (registeredAccelerator) {
    globalShortcut.unregister(registeredAccelerator);
    pttLog("Unregistered global:", registeredAccelerator);
    registeredAccelerator = null;
  }

  globalShortcut.unregisterAll();
}

/**
 * Get current PTT state
 */
export function getPushToTalkState(): boolean {
  return isPttActive;
}

/**
 * Initialize push-to-talk module
 */
export function initPushToTalk(): void {
  pttLog("Initializing PTT (before-input-event method)...");
  pttLog("Config:", {
    enabled: config.pushToTalk,
    keybind: config.pushToTalkKeybind,
    mode: config.pushToTalkMode,
  });

  // Listen for manual PTT from renderer
  ipcMain.on("push-to-talk-manual", (_, data: { active: boolean }) => {
    pttLog("Manual PTT state:", data.active);
    isPttActive = data.active;
    sendPttState(data.active);
  });

  // Register initial hotkey
  if (config.pushToTalk) {
    registerPushToTalkHotkey();
  }
}

/**
 * Cleanup PTT on app quit
 */
export function cleanupPushToTalk(): void {
  pttLog("Cleaning up PTT...");
  unregisterPushToTalkHotkey();
}
