import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { defineConfig } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = resolve(projectRoot, "..");
const outputRoot = existsSync(resolve(workspaceRoot, "package-lock.json")) ? resolve(workspaceRoot, "dist") : resolve(projectRoot, "dist");

export default defineConfig({
  root: projectRoot,
  base: "./",
  cacheDir: resolve(workspaceRoot, "node_modules", ".vite"),
  publicDir: resolve(projectRoot, "public"),
  build: {
    outDir: outputRoot,
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022"
  },
  server: {
    host: "127.0.0.1",
    port: 4173
  }
});
