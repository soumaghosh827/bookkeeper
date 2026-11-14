import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";

const { version } = JSON.parse(readFileSync(resolve("package.json"), "utf-8"));

const shared = { "@shared": resolve("src/shared") };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
  },
  renderer: {
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [react()],
    resolve: { alias: { ...shared, "@": resolve("src/renderer/src") } },
  },
});
