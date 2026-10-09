import { defineConfig } from 'vite';

/**
 * Where the authoritative game server listens (see src/server/server.ts).
 * Keep this in step with the PORT default there. Not 8080 — Docker commonly
 * holds that port.
 */
const GAME_SERVER = process.env.GAME_SERVER ?? 'http://localhost:8787';

export default defineConfig({
  server: {
    port: 5173,
    open: false,
    /**
     * Proxy the game socket to the authoritative server.
     *
     * Keeping the client on a single origin means no CORS, no mixed-content
     * problems over https, no hard-coded host in the client, and the same code
     * path works when both are deployed behind one domain.
     */
    proxy: {
      '/ws': { target: GAME_SERVER, ws: true, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
