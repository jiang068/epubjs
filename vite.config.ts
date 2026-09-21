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
    // Source maps stay opt-in for release builds: they add several MB and
    // expose the full source tree from a public static host.
    sourcemap: process.env.VITE_SOURCEMAP === "true",
    target: "es2022"
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    // Dependencies live in the workspace shell one level above the Git
    // project. Allow Vite's development server to serve the PDF worker URL
    // generated from pdfjs-dist instead of falling back to a fake worker.
    fs: { allow: [workspaceRoot] }
  }
});
