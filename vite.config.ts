import { defineConfig } from "vite";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig({
  // Relative asset paths so the build works when served from a subpath such as
  // GitHub Pages (https://<user>.github.io/<repo>/) as well as from localhost.
  base: "./",
  plugins: [
    // Emit nomodule fallback bundles + polyfills so older desktop browsers that
    // lack native ES modules / newer JS features can still load. NOTE: the match
    // itself renders via PixiJS 8, which needs WebGL2 — so genuinely ancient
    // browsers can reach the lobby but can't run the game scene.
    legacy({
      targets: ["defaults", "not IE 11"],
      modernPolyfills: true, // polyfill newer APIs in the modern bundle too
    }),
  ],
  build: {
    // Broaden the modern bundle's floor (Safari 13+, older Chrome/Firefox/Edge).
    target: "es2019",
  },
  server: {
    host: true, // expose on the LAN so a second device can join the demo
    port: 5173,
  },
});
