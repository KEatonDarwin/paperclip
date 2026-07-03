import path from "path";
import { execSync } from "child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function gitShort(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: __dirname }).toString().trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  // Globals referenced by src/components/VersionInfoModal.tsx (declared in src/globals.d.ts).
  // Must be JSON.stringified so Vite injects literal string values, not bare identifiers.
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __UI_GIT_HASH__: JSON.stringify(gitShort()),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
});
