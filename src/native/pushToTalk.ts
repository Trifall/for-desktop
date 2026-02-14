import { globalShortcut, ipcMain } from "electron";

import { config } from "./config";
import { mainWindow } from "./window";

// Debug logging helper
function pttLog(...args: unknown[]) {
  console.log("[PTT-DEBUG]", ...args);
}

// Track PTT state
let isPttActive = false;
let registeredAccelerator: string | null = null;
let isWayland = false;
let portalAvailable = false;
let dbusBus: unknown = null;
let dbusMessageHandler: ((msg: unknown) => void) | null = null;
let globalKeyListener:
  | import("node-global-key-listener").GlobalKeyboardListener
  | null = null;

// Log initial module load
pttLog("Module loaded. Initial state:", {
  isPttActive,
  registeredAccelerator,
  isWayland,
  portalAvailable,
  hasMainWindow: !!mainWindow,
});

// DBus types
type DBusBus = {
  invoke: (
    message: {
      path: string;
      destination: string;
      interface: string;
      member: string;
      signature?: string;
      body?: unknown;
    },
    callback: (err: Error | null, result: unknown) => void,
  ) => void;
  addMatch: (rule: string, callback: () => void) => void;
  removeMatch: (rule: string, callback: () => void) => void;
  on: (event: string, callback: (msg: unknown) => void) => void;
  removeListener: (event: string, callback: (msg: unknown) => void) => void;
};

/**
 * Check if running on Wayland
 */
function detectWayland(): boolean {
  const isWl =
    process.env.WAYLAND_DISPLAY !== undefined ||
    process.env.XDG_SESSION_TYPE === "wayland";
  pttLog("detectWayland():", {
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    result: isWl,
  });
  return isWl;
}

/**
 * Check if xdg-desktop-portal is available for global shortcuts
 */
async function checkPortalAvailability(): Promise<boolean> {
  pttLog("checkPortalAvailability() called");
  if (process.platform !== "linux") {
    pttLog("Not Linux, skipping portal check");
    return false;
  }

  try {
    pttLog("Checking for xdg-desktop-portal...");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dbus = require("@homebridge/dbus-native");
    const bus: DBusBus = dbus.sessionBus();
    pttLog("DBus session bus created");

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pttLog("Portal check timeout - no GlobalShortcuts support");
        resolve(false);
      }, 1000);

      bus.invoke(
        {
          path: "/org/freedesktop/portal/desktop",
          destination: "org.freedesktop.portal.Desktop",
          interface: "org.freedesktop.DBus.Introspectable",
          member: "Introspect",
        },
        (err: Error | null, result: unknown) => {
          clearTimeout(timeout);
          if (err) {
            pttLog("Portal introspection error:", err.message);
            resolve(false);
            return;
          }
          // Check if GlobalShortcuts portal is available
          const hasGlobalShortcuts =
            typeof result === "string" &&
            result.includes("org.freedesktop.portal.GlobalShortcuts");
          pttLog("Portal introspection result:", {
            hasGlobalShortcuts,
            resultLength: typeof result === "string" ? result.length : 0,
          });
          resolve(hasGlobalShortcuts);
        },
      );
    });
  } catch (err) {
    pttLog("checkPortalAvailability() error:", err);
    return false;
  }
}

/**
 * Send PTT state to renderer safely
 */
function sendPttState(active: boolean) {
  pttLog("sendPttState() called:", {
    active,
    hasMainWindow: !!mainWindow,
    isDestroyed: mainWindow?.isDestroyed(),
    webContentsDestroyed: mainWindow?.webContents?.isDestroyed(),
  });

  // Check if window exists and is not destroyed before sending
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    pttLog("Sending PTT state to renderer:", active);
    mainWindow.webContents.send("push-to-talk", { active });
    pttLog("PTT state sent successfully");
  } else {
    pttLog("WARNING: Cannot send PTT state - window not available");
  }
}

/**
 * Send local keybind to renderer safely
 */
function sendLocalKeybind(accelerator: string) {
  pttLog("sendLocalKeybind() called:", accelerator);

  // Check if window exists and is not destroyed before sending
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send("push-to-talk-local", { accelerator });
    pttLog("Local keybind sent successfully");
  } else {
    pttLog("WARNING: Cannot send local keybind - window not available");
  }
}

/**
 * Parse accelerator to target key
 */
function parseAccelerator(accelerator: string): {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
} {
  const parts = accelerator
    .toLowerCase()
    .split("+")
    .map((p) => p.trim());
  const key = parts.pop() || "";

  const result = {
    key,
    ctrl: parts.includes("ctrl") || parts.includes("control"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    meta:
      parts.includes("meta") ||
      parts.includes("command") ||
      parts.includes("cmd"),
  };

  pttLog("parseAccelerator():", accelerator, "->", result);
  return result;
}

/**
 * Register global hotkey with fallbacks for different platforms
 */
export async function registerPushToTalkHotkey(): Promise<void> {
  pttLog("registerPushToTalkHotkey() called");
  pttLog("Current config:", {
    pushToTalk: config.pushToTalk,
    pushToTalkKeybind: config.pushToTalkKeybind,
    pushToTalkMode: config.pushToTalkMode,
  });

  if (!config.pushToTalk) {
    pttLog("PTT disabled in config, unregistering");
    unregisterPushToTalkHotkey();
    return;
  }

  const accelerator = config.pushToTalkKeybind || "Shift+Space";
  pttLog("Using accelerator:", accelerator);

  // Don't re-register if already registered with same accelerator
  if (registeredAccelerator === accelerator) {
    pttLog("Already registered with same accelerator, skipping");
    return;
  }

  // Unregister existing hotkey first
  pttLog("Unregistering existing hotkey first");
  unregisterPushToTalkHotkey();

  // For hold mode on Linux/X11/XWayland, use node-global-key-listener for proper keyup/keydown detection
  if (config.pushToTalkMode === "hold" && process.platform === "linux") {
    pttLog("Hold mode on Linux, trying node-global-key-listener...");
    const listenerSuccess = await registerGlobalKeyListener(accelerator);
    pttLog("node-global-key-listener result:", listenerSuccess);

    if (listenerSuccess) {
      pttLog("✓ Using node-global-key-listener for hold mode on X11");
      return;
    }
    pttLog("✗ node-global-key-listener failed, falling back to globalShortcut");
  }

  // Use native globalShortcut for toggle mode or as fallback
  pttLog("Trying native globalShortcut...");
  const nativeSuccess = registerNativeHotkey(accelerator);
  pttLog("Native globalShortcut result:", nativeSuccess);

  if (nativeSuccess) {
    pttLog("✓ Using native global shortcuts");

    // Warn about hold mode limitations with globalShortcut
    if (config.pushToTalkMode === "hold") {
      console.warn(
        "[PTT] WARNING: You are using 'hold' mode with globalShortcut. " +
          "The microphone will toggle on each key press (not true hold behavior). " +
          "Consider using X11/XWayland for better hold mode support.",
      );
    }
    return;
  }

  // Native registration failed - check if we're on Wayland
  pttLog("Native registration failed, checking for Wayland...");
  isWayland = detectWayland();

  if (isWayland && process.platform === "linux") {
    pttLog("Wayland detected, trying portal...");
    portalAvailable = await checkPortalAvailability();

    if (!portalAvailable) {
      pttLog("✗ Wayland portal not available");
      console.warn(
        "[PTT] Wayland detected but no xdg-desktop-portal GlobalShortcuts support. " +
          "Push-to-talk will not work globally. Please set up a system shortcut manually.",
      );
      // Still try to register for when window has focus
      registerLocalHotkey(accelerator);
      return;
    }

    // Use portal for Wayland
    pttLog("Using Wayland portal...");
    await registerWaylandHotkey(accelerator);
  } else {
    // Not Wayland, but native registration failed
    pttLog("✗ Failed to register native global shortcuts");
    registerLocalHotkey(accelerator);
  }
}

/**
 * Register global key listener for proper hold mode on X11
 * @returns true if registration succeeded
 */
async function registerGlobalKeyListener(
  accelerator: string,
): Promise<boolean> {
  pttLog("registerGlobalKeyListener() called with:", accelerator);

  try {
    pttLog("Importing node-global-key-listener...");
    const { GlobalKeyboardListener } = await import("node-global-key-listener");
    const { key, ctrl, shift, alt, meta } = parseAccelerator(accelerator);

    pttLog("Creating GlobalKeyboardListener instance...");
    globalKeyListener = new GlobalKeyboardListener();
    pttLog("GlobalKeyboardListener created successfully");

    // Track modifier states
    const modifierState = {
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    };

    // Helper to check if all required modifiers are pressed
    const hasAllModifiers = () => {
      if (ctrl && !modifierState.ctrl) return false;
      if (shift && !modifierState.shift) return false;
      if (alt && !modifierState.alt) return false;
      if (meta && !modifierState.meta) return false;
      return true;
    };

    // Handle all key events
    globalKeyListener.addListener((e) => {
      const keyName = e.name?.toLowerCase() || "";
      pttLog("Raw key event:", {
        name: e.name,
        keyName,
        state: e.state,
        vKey: e.vKey,
      });

      // Update modifier state for modifier keys
      if (keyName === "left ctrl" || keyName === "right ctrl") {
        modifierState.ctrl = e.state === "DOWN";
        pttLog("Modifier ctrl:", modifierState.ctrl);
      }
      if (keyName === "left shift" || keyName === "right shift") {
        modifierState.shift = e.state === "DOWN";
        pttLog("Modifier shift:", modifierState.shift);
      }
      if (keyName === "left alt" || keyName === "right alt") {
        modifierState.alt = e.state === "DOWN";
        pttLog("Modifier alt:", modifierState.alt);
      }
      if (
        keyName === "left meta" ||
        keyName === "right meta" ||
        keyName === "command"
      ) {
        modifierState.meta = e.state === "DOWN";
        pttLog("Modifier meta:", modifierState.meta);
      }

      // Check if this is our PTT key
      const keyMatch = keyName === key || keyName.includes(key);
      pttLog("Key match check:", {
        keyName,
        targetKey: key,
        keyMatch,
        hasAllModifiers: hasAllModifiers(),
      });

      if (keyMatch && e.state === "DOWN" && hasAllModifiers()) {
        pttLog("PTT KEY PRESSED! Activating mic...");
        if (!isPttActive) {
          isPttActive = true;
          pttLog("Setting isPttActive = true");
          sendPttState(true);
          pttLog("✓ Mic ON");
        } else {
          pttLog("Mic already ON, ignoring");
        }
        return true; // Prevent propagation
      }

      if (keyMatch && e.state === "UP") {
        pttLog("PTT KEY RELEASED! Deactivating mic...");
        if (isPttActive) {
          isPttActive = false;
          pttLog("Setting isPttActive = false");
          sendPttState(false);
          pttLog("✓ Mic OFF");
        } else {
          pttLog("Mic already OFF, ignoring");
        }
        return true; // Prevent propagation
      }

      return false;
    });

    registeredAccelerator = accelerator;
    pttLog("✓ Registered global key listener:", accelerator);
    return true;
  } catch (err) {
    pttLog("✗ Error registering global key listener:", err);
    return false;
  }
}

/**
 * Register native global hotkey using Electron's globalShortcut
 * @returns true if registration succeeded, false otherwise
 */
function registerNativeHotkey(accelerator: string): boolean {
  pttLog("registerNativeHotkey() called:", accelerator);

  try {
    if (config.pushToTalkMode === "hold") {
      pttLog("Hold mode with native shortcuts - will act as toggle");
      // Register the main hotkey - acts as toggle since we can't detect keyup
      const success = globalShortcut.register(accelerator, () => {
        pttLog("Native hotkey triggered (toggle mode)");
        isPttActive = !isPttActive;
        pttLog("Toggling isPttActive to:", isPttActive);
        sendPttState(isPttActive);
        pttLog("Toggle:", isPttActive ? "ON" : "OFF");
      });

      if (success) {
        registeredAccelerator = accelerator;
        pttLog("✓ Registered toggle hotkey:", accelerator);
        return true;
      } else {
        pttLog("✗ Failed to register toggle hotkey");
        return false;
      }
    } else {
      pttLog("Toggle mode with native shortcuts");
      // Toggle mode - normal implementation
      const success = globalShortcut.register(accelerator, () => {
        pttLog("Native hotkey triggered (toggle mode)");
        isPttActive = !isPttActive;
        sendPttState(isPttActive);
      });

      if (success) {
        registeredAccelerator = accelerator;
        pttLog("✓ Registered toggle hotkey:", accelerator);
        return true;
      } else {
        pttLog("✗ Failed to register toggle hotkey");
        return false;
      }
    }
  } catch (err) {
    pttLog("✗ Error registering hotkey:", err);
    return false;
  }
}

/**
 * Register hotkey for Wayland using xdg-desktop-portal
 */
async function registerWaylandHotkey(accelerator: string): Promise<void> {
  pttLog("registerWaylandHotkey() called:", accelerator);

  try {
    pttLog("Importing dbus-native...");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dbus = require("@homebridge/dbus-native");
    const bus: DBusBus = dbus.sessionBus();
    dbusBus = bus;
    pttLog("DBus bus created");

    // Create a portal session
    pttLog("Creating portal session...");
    const requestPath = await new Promise<string>((resolve, reject) => {
      bus.invoke(
        {
          path: "/org/freedesktop/portal/desktop",
          destination: "org.freedesktop.portal.GlobalShortcuts",
          interface: "org.freedesktop.portal.GlobalShortcuts",
          member: "CreateSession",
          signature: "sa{sv}",
          body: [
            "stoat_ptt_" + Date.now(),
            {
              handle_token: "stoat_ptt_" + Date.now(),
            },
          ],
        },
        (err: Error | null, result: unknown) => {
          if (err) {
            pttLog("CreateSession error:", err);
            reject(err);
          } else {
            pttLog("CreateSession success:", result);
            resolve(result as string);
          }
        },
      );
    });

    pttLog("Created Wayland portal session:", requestPath);

    // For Wayland, we need to listen for the RequestResponse signal
    // to get the actual session path
    pttLog("Adding Request signal listener...");
    bus.addMatch(
      "type='signal',interface='org.freedesktop.portal.Request'",
      // Callback is required by dbus-native but we handle signals via bus.on()
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      () => {},
    );

    // Bind shortcuts
    const shortcuts = [
      {
        id: "push-to-talk",
        description: "Push to Talk",
        trigger_description: accelerator,
      },
    ];

    pttLog("Binding shortcuts:", shortcuts);
    bus.invoke(
      {
        path: "/org/freedesktop/portal/desktop",
        destination: "org.freedesktop.portal.GlobalShortcuts",
        interface: "org.freedesktop.portal.GlobalShortcuts",
        member: "BindShortcuts",
        signature: "ossa{sv}",
        body: [requestPath, "stoat-desktop", shortcuts, {}],
      },
      (err: Error | null) => {
        if (err) {
          pttLog("✗ Failed to bind Wayland shortcuts:", err);
        } else {
          pttLog("✓ Bound Wayland shortcuts successfully");
          registeredAccelerator = accelerator;
        }
      },
    );

    // Listen for shortcut events
    pttLog("Adding GlobalShortcuts signal listener...");
    bus.addMatch(
      "type='signal',interface='org.freedesktop.portal.GlobalShortcuts'",
      // Callback is required by dbus-native but we handle signals via bus.on()
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      () => {},
    );

    interface PortalMessage {
      member?: string;
      body?: [string, string, unknown];
    }

    dbusMessageHandler = (msg: unknown) => {
      const message = msg as PortalMessage;
      pttLog("Portal message received:", message.member);

      if (message.member === "Activated") {
        const [, shortcutId] = message.body || [];
        pttLog("Portal shortcut activated:", shortcutId);
        if (shortcutId === "push-to-talk") {
          if (config.pushToTalkMode === "hold") {
            pttLog("Hold mode: Activating mic");
            isPttActive = true;
            sendPttState(true);
          } else {
            pttLog("Toggle mode: Toggling mic");
            isPttActive = !isPttActive;
            sendPttState(isPttActive);
          }
        }
      } else if (message.member === "Deactivated") {
        const [, shortcutId] = message.body || [];
        pttLog("Portal shortcut deactivated:", shortcutId);
        if (shortcutId === "push-to-talk" && config.pushToTalkMode === "hold") {
          pttLog("Hold mode: Deactivating mic");
          isPttActive = false;
          sendPttState(false);
        }
      }
    };

    bus.on("message", dbusMessageHandler);
    pttLog("Portal message handler registered");
  } catch (err) {
    // Check if this is a "service unknown" error - portal not available
    const error = err as Error & { name?: string; message?: unknown };
    const errorMessage = Array.isArray(error.message)
      ? error.message[0]
      : String(error.message);

    if (
      error.name === "org.freedesktop.DBus.Error.ServiceUnknown" ||
      errorMessage.includes("not provided by any .service files")
    ) {
      pttLog("Portal service not available");
      console.warn(
        "[PTT] xdg-desktop-portal GlobalShortcuts not available. " +
          "Falling back to local hotkeys (window focus only).",
      );
      portalAvailable = false;
      registerLocalHotkey(accelerator);
    } else {
      pttLog("✗ Error registering Wayland hotkey:", err);
    }
  }
}

/**
 * Register local hotkey (only works when window is focused)
 */
function registerLocalHotkey(accelerator: string): void {
  pttLog("registerLocalHotkey() called:", accelerator);
  // This will be handled by the renderer process
  // We'll notify the renderer to set up local key handlers
  sendLocalKeybind(accelerator);
}

/**
 * Unregister all PTT hotkeys
 */
export function unregisterPushToTalkHotkey(): void {
  pttLog("unregisterPushToTalkHotkey() called");

  // Stop global key listener if active
  if (globalKeyListener) {
    pttLog("Stopping global key listener...");
    try {
      globalKeyListener.kill();
      pttLog("✓ Stopped global key listener");
    } catch (err) {
      pttLog("✗ Error stopping global key listener:", err);
    }
    globalKeyListener = null;
  }

  if (registeredAccelerator) {
    pttLog("Unregistering accelerator:", registeredAccelerator);
    if (!isWayland || !portalAvailable) {
      pttLog("Unregistering from globalShortcut");
      globalShortcut.unregister(registeredAccelerator);
    }
    registeredAccelerator = null;
    isPttActive = false;
    sendPttState(false);
    pttLog("✓ Unregistered hotkey");
  }

  // Clean up DBus listeners on Wayland
  if (dbusBus && dbusMessageHandler) {
    pttLog("Cleaning up DBus listeners...");
    try {
      const bus = dbusBus as DBusBus;
      bus.removeListener("message", dbusMessageHandler);

      // Remove match rules
      bus.removeMatch(
        "type='signal',interface='org.freedesktop.portal.Request'",
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        () => {},
      );
      bus.removeMatch(
        "type='signal',interface='org.freedesktop.portal.GlobalShortcuts'",
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        () => {},
      );
      pttLog("✓ Cleaned up DBus listeners");
    } catch (err) {
      pttLog("✗ Error cleaning up DBus listeners:", err);
    }
    dbusBus = null;
    dbusMessageHandler = null;
  }

  // Reset state variables
  pttLog("Resetting state variables");
  isWayland = false;
  portalAvailable = false;
}

/**
 * Get current PTT state
 */
export function getPushToTalkState(): boolean {
  pttLog("getPushToTalkState() called:", isPttActive);
  return isPttActive;
}

/**
 * Check if running on Wayland without portal support
 */
export function isWaylandWithoutPortal(): boolean {
  const result = isWayland && !portalAvailable;
  pttLog("isWaylandWithoutPortal():", result);
  return result;
}

/**
 * Initialize push-to-talk module
 */
export function initPushToTalk(): void {
  pttLog("initPushToTalk() called");
  pttLog("Config at init:", {
    pushToTalk: config.pushToTalk,
    pushToTalkKeybind: config.pushToTalkKeybind,
    pushToTalkMode: config.pushToTalkMode,
  });

  // Listen for manual PTT toggle from renderer (for Wayland workaround)
  ipcMain.on("push-to-talk-manual", (_, data: unknown) => {
    pttLog("Received push-to-talk-manual IPC:", data);
    // Validate input
    if (
      data &&
      typeof data === "object" &&
      "active" in data &&
      typeof (data as { active: boolean }).active === "boolean"
    ) {
      const { active } = data as { active: boolean };
      pttLog("Setting PTT state to:", active);
      isPttActive = active;
      sendPttState(active);
    } else {
      pttLog("WARNING: Invalid manual state data received:", data);
    }
  });

  // Register initial hotkey if enabled
  if (config.pushToTalk) {
    pttLog("PTT enabled, initializing with mic OFF");
    // Ensure mic starts muted (PTT off)
    isPttActive = false;
    pttLog("Setting initial state: isPttActive = false");
    sendPttState(false);
    pttLog("Calling registerPushToTalkHotkey()...");
    registerPushToTalkHotkey().catch((err) => {
      pttLog("✗ Failed to register initial hotkey:", err);
    });
  } else {
    pttLog("PTT disabled in config, skipping registration");
  }
}

/**
 * Cleanup PTT on app quit
 */
export function cleanupPushToTalk(): void {
  pttLog("cleanupPushToTalk() called");
  unregisterPushToTalkHotkey();
}
