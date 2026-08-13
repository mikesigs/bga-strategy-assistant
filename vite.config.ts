import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
  define: {
    // Embed build timestamp at compile time — visible in the UI as a version indicator
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    crx({ manifest }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});
