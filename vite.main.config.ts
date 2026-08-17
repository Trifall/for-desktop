import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        "keyspy",
        "electron",
        "bufferutil",
        "utf-8-validate",
        "node-pipewire",
      ],
    },
  },
});
