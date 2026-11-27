import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sourceRevision } from "./scripts/source-revision.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: "/team/",
  define: { __MIRRORORDER_FRONTEND_REVISION__: JSON.stringify(sourceRevision()) },
  clearScreen: false,
  build: {
    outDir: resolve(here, "../web/team"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(here, "team.html"),
      },
      output: {
        entryFileNames: "assets/team-review.js",
        chunkFileNames: "assets/team-[name].js",
        assetFileNames: "assets/team-review.[ext]",
      },
    },
  },
});
