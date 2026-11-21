import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sourceRevision } from "./scripts/source-revision.mjs";

const host = process.env.TAURI_DEV_HOST;
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: { __MIRRORORDER_FRONTEND_REVISION__: JSON.stringify(sourceRevision()) },
  clearScreen: false,
  build: {
    rollupOptions: {
      input: { main: resolve(here, "index.html"), xiaojing: resolve(here, "xiaojing.html") },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
