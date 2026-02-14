# Running Stoat Desktop + Web Client Together

## Folder Structure

You should have:

```
stoat/
├── stoat-for-desktop/     # Desktop Electron app
└── client/                # Web client (Solid.js)
```

## Step 1: Run the Web Client

Open a terminal and run:

```bash
cd ~/Projects/stoat/client

# Install dependencies (if not done)
pnpm install

# Run dev server
mise dev
```

This will start the web client at `http://localhost:5173`

**Wait until you see:**

```
VITE v5.x.x  ready in XXX ms

➜  Local:   http://localhost:5173/
➜  Network: http://192.168.x.x:5173/
```

## Step 2: Run the Desktop App

Open a **second** terminal and run:

```bash
cd ~/Projects/stoat/stoat-for-desktop

# Run with XWayland and connect to local web client
npx electron-forge start -- --ozone-platform=x11 --force-server=http://localhost:5173
```

This will:

- Start the desktop app in XWayland mode (for PTT support)
- Load the web client from your local dev server
- Enable push-to-talk with proper hold-mode detection

## Step 3: Configure PTT

### Option 1: Via Config File (Recommended)

The config is stored in the following location:

- **Linux**: `~/.config/stoat-desktop/config.json`
- **macOS**: `~/Library/Application Support/stoat-desktop/config.json`
- **Windows**: `%APPDATA%/stoat-desktop/config.json`

Edit the config file and add:

```json
{
  "pushToTalk": true,
  "pushToTalkKeybind": "V",
  "pushToTalkMode": "hold",
  "pushToTalkReleaseDelay": 250
}
```

**Config Options:**

- `pushToTalk`: Enable/disable PTT (boolean)
- `pushToTalkKeybind`: Key to use (string, e.g., "V", "Shift+V", "F8")
- `pushToTalkMode`: "hold" or "toggle"
- `pushToTalkReleaseDelay`: Delay in ms before muting after release (0-5000)

### Option 2: Via DevTools Console

Open DevTools in the desktop app (press **F12**) and run:

```javascript
// Enable push-to-talk
window.desktopConfig.set({ pushToTalk: true });

// Set your keybind (examples)
window.desktopConfig.set({ pushToTalkKeybind: "V" });
window.desktopConfig.set({ pushToTalkKeybind: "Shift+V" });
window.desktopConfig.set({ pushToTalkKeybind: "F8" });

// Use hold mode for push-to-talk behavior
window.desktopConfig.set({ pushToTalkMode: "hold" });

// Set release delay (ms)
window.desktopConfig.set({ pushToTalkReleaseDelay: 250 });

// View current settings
console.log(window.desktopConfig.get());
```

## Step 4: Test PTT

1. Join a voice channel in Stoat
2. Press and **hold** your PTT key (e.g., "V")
3. You should see in the console: `[PTT] State: ON`
4. Your mic should unmute (red indicator in voice UI)
5. Release the key
6. You should see: `[PTT] State: OFF`
7. Your mic should mute after the release delay

## Troubleshooting

### Web client won't start

```bash
# Make sure you're in the right directory
cd ~/Projects/stoat/client

# Check if node_modules exists
ls node_modules/.bin/vite 2>/dev/null || pnpm install

# Try running dev server
pnpm dev
```

### Desktop app shows white screen

- Make sure the web client is running first
- Check that http://localhost:5173 loads in your browser
- Try restarting both apps

### PTT not working

1. Check you're using `--ozone-platform=x11` flag
2. Open DevTools (F12) and check console for errors
3. Verify `window.pushToTalk` exists:
   ```javascript
   console.log(window.pushToTalk);
   ```
4. Make sure you're in a voice channel
5. Check the config file location above and verify settings

### Can't type PTT key in chat

The desktop app now handles this automatically:

- When focused: Uses `before-input-event` without `preventDefault()`, allowing typing
- When unfocused: Uses `globalShortcut` for global hotkey detection
- You should be able to type your PTT key in chat AND use it for PTT

### Permission denied errors

The desktop app needs access to:

- Microphone (for voice)
- Keyboard (for global hotkeys)

On Linux, you may need to add your user to the `input` group:

```bash
sudo usermod -a -G input $USER
# Log out and log back in
```

## Development Workflow

**Terminal 1** (Web Client):

```bash
cd ~/Projects/stoat/client
mise dev
# Keep this running - auto-reloads on file changes
```

**Terminal 2** (Desktop App):

```bash
cd ~/Projects/stoat/stoat-for-desktop
npx electron-forge start -- --ozone-platform=x11 --force-server=http://localhost:5173
# Restart this when you change desktop app code
```

**Making Changes:**

- Web client code: Edit files in `~/Projects/stoat/client/` - changes auto-reload
- Desktop app code: Edit files in `~/Projects/stoat/stoat-for-desktop/` - restart the app
- PTT integration: Changes are in `client/packages/client/components/rtc/state.tsx`

## Quick Commands Reference

```bash
# Start web client
cd ~/Projects/stoat/client && mise dev

# Start desktop app (XWayland)
cd ~/Projects/stoat/stoat-for-desktop && npx electron-forge start -- --ozone-platform=x11 --force-server=http://localhost:5173

# Start desktop app (native Wayland - PTT won't work)
cd ~/Projects/stoat/stoat-for-desktop && pnpm start -- --force-server=http://localhost:5173
```

## What's Different?

**Without this setup:**

- Desktop app loads https://stoat.chat (production)
- Push-to-talk doesn't work because web client doesn't listen for it

**With this setup:**

- Desktop app loads http://localhost:5173 (your local dev version)
- Web client has PTT integration code
- Desktop app uses XWayland for proper global hotkey support
- Full push-to-talk with hold-mode and release delay works!

## Config File Location

The desktop app stores its configuration using `electron-store`. The config file is located at:

**Linux:** `~/.config/stoat-desktop/config.json`

**macOS:** `~/Library/Application Support/stoat-desktop/config.json`

**Windows:** `%APPDATA%/stoat-desktop/config.json`

Example config:

```json
{
  "pushToTalk": true,
  "pushToTalkKeybind": "V",
  "pushToTalkMode": "hold",
  "pushToTalkReleaseDelay": 250,
  "customFrame": true,
  "minimiseToTray": true
}
```
