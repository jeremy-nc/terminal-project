import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build output goes to ../dist-relative `dist`, which FastAPI serves in
// production. In dev (`npm run dev`) Vite serves on :5173 and proxies the
// WebSocket to the Python backend on :8000 so one `python3 server.py`
// backend works for both modes.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Allow access through tunnels (e.g. ngrok). A leading dot allows the domain
    // and all its subdomains, so rotating ngrok URLs keep working.
    allowedHosts: [".ngrok-free.dev", ".ngrok-free.app", ".ngrok.io"],
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8000",
        ws: true,
      },
      // Slack OAuth start/callback are handled by the Python backend.
      "/slack": { target: "http://127.0.0.1:8000" },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
