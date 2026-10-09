# YOVNOK — one container serves the built client AND the authoritative socket,
# on one origin (see DEPLOY.md).
#
#   docker build -t yovnok .
#   docker run --rm -p 8787:8787 yovnok
#
# The runtime is **distroless**: no shell, no package manager, no tsx. Production
# therefore runs one pre-bundled JavaScript file (`dist-server/server.mjs`) whose
# only bare import is `ws`, which is the only thing copied into the image. That
# is why the server is bundled at build time rather than compiled file-by-file.

# ---------------------------------------------------------------- build
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# tsc --noEmit + client build + server bundle.
RUN npm run build

# A production-only dependency tree, so `ws` can be lifted into the runtime
# without the build toolchain (or the client-only `three`) following it.
RUN mkdir -p /prod && cp package.json package-lock.json /prod/ \
 && cd /prod && npm ci --omit=dev && npm cache clean --force

# Guard the distroless assumption: the bundle must import nothing but Node
# builtins and `ws`. If someone adds a dependency to the server and forgets it
# here, the build fails now instead of the container failing to start.
RUN node -e "const fs=require('fs'); const s=fs.readFileSync('dist-server/server.mjs','utf8'); \
 const bad=[...s.matchAll(/from\s*[\"']([^\"']+)[\"']/g)].map(m=>m[1]).filter(p=>!p.startsWith('.')&&!p.startsWith('node:')&&p!=='ws'); \
 if(bad.length){console.error('unexpected server externals:',bad);process.exit(1)}"

# ---------------------------------------------------------------- runtime
# Distroless Node, non-root. No shell: HEALTHCHECK uses the node binary directly.
FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
# Absolute client dir: the server resolves `dist/` from cwd by default, and this
# removes any doubt about where a container starts.
ENV CLIENT_DIR=/app/dist
# The bundle ships a sourcemap; make stack traces point at real source.
ENV NODE_OPTIONS=--enable-source-maps

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /prod/node_modules/ws ./node_modules/ws

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The distroless nodejs entrypoint is already `/nodejs/bin/node`.
CMD ["/app/dist-server/server.mjs"]
