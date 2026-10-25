import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: false },
      "/fhir": { target: "http://localhost:8787", changeOrigin: false },
      "/terminology": { target: "http://localhost:8787", changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
