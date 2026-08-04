import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src/renderer"),
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/renderer/tests/setup.ts"],
    include: [
      "src/*.test.ts",
      "src/renderer/**/*.test.ts",
      "src/renderer/**/*.test.tsx",
      "src/psb/**/*.test.ts",
    ],
  },
});
