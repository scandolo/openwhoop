import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  publicDir: "../../public",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: { port: 5173, proxy: { "/api": `http://127.0.0.1:${process.env.PORT ?? 8787}` } },
});
