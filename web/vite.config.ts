import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": `http://localhost:${process.env.BOSSMODE_API_PORT || 8080}`,
      "/ws": {
        target: `ws://localhost:${process.env.BOSSMODE_API_PORT || 8080}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
