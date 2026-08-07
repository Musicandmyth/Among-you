/// <reference types="vite/client" />

/** Client-visible env vars (Vite inlines these at build time). See iceConfig()
 *  in net.ts. Note: anything VITE_* is embedded in the public bundle and readable
 *  by users — use short-lived / ephemeral TURN credentials in production. */
interface ImportMetaEnv {
  readonly VITE_TURN_URLS?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
  readonly VITE_ICE_RELAY_ONLY?: string;
  // Optional custom PeerJS signaling server (defaults to the PeerJS cloud).
  readonly VITE_PEER_HOST?: string;
  readonly VITE_PEER_PORT?: string;
  readonly VITE_PEER_PATH?: string;
  readonly VITE_PEER_KEY?: string;
  readonly VITE_PEER_SECURE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
