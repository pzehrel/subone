# syntax=docker/dockerfile:1
FROM node:24.22.2-alpine AS base
WORKDIR /app
RUN npm install --global pnpm@12.16.1

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,id=subone-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM dependencies AS builder
COPY tsconfig.base.json ./
COPY apps/ ./apps/
COPY shared/ ./shared/
RUN pnpm build

FROM base AS production-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,id=subone-pnpm,target=/pnpm/store \
    pnpm install --filter @subone/server --prod --frozen-lockfile --ignore-scripts --store-dir /pnpm/store

FROM node:24.22.2-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3456

LABEL org.opencontainers.image.title="SubOne" \
      org.opencontainers.image.source="https://github.com/pzehrel/subone" \
      org.opencontainers.image.authors="pzehrel <pzehrel@gmail.com>"

RUN apk add --no-cache su-exec \
    && mkdir -p /app/data /app/templates \
    && chown node:node /app /app/data /app/templates
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY templates/ ./templates.default/
COPY --chmod=755 docker-entrypoint.sh ./

EXPOSE 3456
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/auth/status').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "apps/server/dist/index.js"]
