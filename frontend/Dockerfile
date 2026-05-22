# ──────────────────────────────────────────────────────────────────────────
# Multi-stage build for Next.js frontend
# ──────────────────────────────────────────────────────────────────────────

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /frontend

COPY package*.json ./

RUN npm ci --prefer-offline --no-audit

COPY . .

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NODE_OPTIONS="--max-old-space-size=8192"
ENV NODE_ENV=production

RUN npm run build

# Stage 2: Runtime (minimal image)
FROM node:20-alpine

WORKDIR /frontend

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy package.json for runtime dependencies
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev --prefer-offline --no-audit && \
    npm cache clean --force

# Copy built application from builder
COPY --from=builder /frontend/.next ./.next
COPY --from=builder /frontend/public ./public
COPY --from=builder /frontend/next.config.js ./next.config.js

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000 || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "start"]