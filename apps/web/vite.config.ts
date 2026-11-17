import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiOrigin = `http://localhost:${process.env.API_PORT ?? "8787"}`;

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: process.env.PLAYWRIGHT_TEST === "1",
    proxy: {
      "/api": { target: apiOrigin, changeOrigin: false },
      "/fhir": { target: apiOrigin, changeOrigin: false },
      "/terminology": { target: apiOrigin, changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
