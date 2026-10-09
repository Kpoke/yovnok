import { defineConfig } from 'vite';

/**
 * Bundles the authoritative server into one plain-JS file (`dist-server/server.mjs`).
 *
 * Why a bundle and not `tsc` output: the runtime image is **distroless** — no
 * shell, no npm, no tsx — so production runs `node dist-server/server.mjs` and
 * nothing else. Bundling also means one artifact instead of a tree of compiled
 * files with matching import specifiers.
 *
 * `ws` is kept external (and copied into the image): it conditionally requires
 * optional native addons, which a bundler would either pull in or warn about.
 * Everything else — our own code and the shared simulation — is inlined.
 *
 * Run with: `npm run build:server`.
 */
export default defineConfig({
  // The server bundle has no assets; without this Vite copies `public/` (audio)
  // into `dist-server/`, doubling the payload for nothing.
  publicDir: false,
  build: {
    ssr: 'src/server/server.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'node24',
    sourcemap: true,
    rollupOptions: {
      output: { entryFileNames: 'server.mjs' },
    },
  },
  ssr: {
    external: ['ws'],
  },
});
