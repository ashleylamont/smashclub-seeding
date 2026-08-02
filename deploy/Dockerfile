# Build from the repository root:
#   docker build -f deploy/Dockerfile -t smashclub:latest .

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN pnpm install --frozen-lockfile
# Stamps the footer's build indicator. Vite statically replaces
# import.meta.env.VITE_BUILD_SHA at build time, so this must be set BEFORE the
# web build; left unset (a plain local `docker build`) the footer reads "dev".
ARG GIT_SHA=""
ENV VITE_BUILD_SHA=$GIT_SHA
RUN pnpm --filter @smashclub/web build && pnpm --filter @smashclub/server build
# Production node_modules for the server (workspace code is already bundled
# into dist/index.js; only real npm deps are external).
RUN pnpm --filter @smashclub/server deploy --prod --legacy /out/server

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/server/node_modules ./node_modules
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/web/dist ./web
COPY --from=build /repo/packages/db/migrations ./migrations
ENV PORT=3000 \
    WEB_DIST_DIR=/app/web \
    MIGRATIONS_DIR=/app/migrations
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
