import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: true, // expose on the LAN so a second device can join the demo
    port: 5173,
  },
});
