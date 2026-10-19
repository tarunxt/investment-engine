FROM node:22-bookworm-slim AS builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci --include=dev --no-audit --fund=false
COPY frontend/ .
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NEXT_STANDALONE_BUILD=true
ENV NEXT_PUBLIC_API_URL=https://uat2.cred-x.in/backend-api NEXT_PUBLIC_FRONTEND_URL=https://uat2.cred-x.in
ENV NEXT_PUBLIC_DISABLE_AUTH=false NEXT_PUBLIC_DISABLE_API_PROXY=false
ARG UAT2_SOURCE_COMMIT
ENV NEXT_PUBLIC_UAT2=true NEXT_PUBLIC_UAT2_COMMIT=$UAT2_SOURCE_COMMIT
# Runtime signing configuration is intentionally not supplied to the image build.
RUN npm run build
FROM node:22-bookworm-slim
ARG UAT2_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$UAT2_SOURCE_COMMIT
WORKDIR /frontend
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /frontend/.next/standalone ./
COPY --from=builder --chown=node:node /frontend/.next/static ./.next/static
COPY --from=builder --chown=node:node /frontend/public ./public
USER node
CMD ["node", "server.js"]
