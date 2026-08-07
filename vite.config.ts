import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build works when served from a subpath such as
  // GitHub Pages (https://<user>.github.io/<repo>/) as well as from localhost.
  base: "./",
  server: {
    host: true, // expose on the LAN so a second device can join the demo
    port: 5173,
  },
});
