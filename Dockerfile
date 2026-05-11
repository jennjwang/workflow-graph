# ─── Build stage ────────────────────────────────────────────────────────────
# Compile TypeScript and bundle the Vite frontend into ./dist.
FROM node:20-alpine AS build
WORKDIR /app

# Bumping CACHE_BUST forces Docker / Cloud Build to discard any cached layer
# of `npm ci`. Bump the value if you regenerate the lock file and the build
# is still pulling in a stale install layer.
ARG CACHE_BUST=2026-05-10
RUN echo "cache bust: $CACHE_BUST"

COPY package.json package-lock.json* ./
# Use `npm install` (not `npm ci`): the lock file has a transitive picomatch
# version conflict that macOS npm tolerates but Linux npm rejects strictly.
# `npm install` resolves it in place. Trade-off: builds aren't as reproducible
# as `npm ci` would give, but they succeed and the runtime behavior is identical.
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

# ─── Runtime stage ──────────────────────────────────────────────────────────
# Minimal image: prod deps + the built frontend + the Express server.
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/prompts ./prompts

EXPOSE 8080
CMD ["node", "server.js"]
