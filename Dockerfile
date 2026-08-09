# Build the SPA and bundle the server, then ship neither toolchain nor
# node_modules — the runtime image is node + two files.
FROM node:24-alpine AS build
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# The sample config is a dev convenience; a container has a real one mounted.
RUN pnpm exec tsc -b \
 && pnpm exec vite build \
 && node scripts/build-server.mjs

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    ORCA_CONFIG_DIR=/config \
    ORCA_STATIC_DIR=/app/web \
    PORT=8099

COPY --from=build /app/dist-server/index.mjs ./index.mjs
COPY --from=build /app/dist ./web

# Runs unprivileged, and only ever reads /config.
USER node
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8099)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.mjs"]
