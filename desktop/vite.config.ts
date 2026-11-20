import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sourceRevision } from "./scripts/source-revision.mjs";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  define: { __MIRRORORDER_FRONTEND_REVISION__: JSON.stringify(sourceRevision()) },
  clearScreen: false,
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
