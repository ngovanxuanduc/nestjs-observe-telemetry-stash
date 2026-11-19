# --- Stage 1: Build ---
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

# --- Stage 2: Runner ---
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV TELEMETRY_PORT=3301
ENV TELEMETRY_STORAGE_DIR=/data/telemetry

COPY package*.json ./
# @aws-sdk/client-s3 là optional peer của lib (devDependency để build) → trong image chuyển nó
# thành dependency để bật S3 chỉ bằng env. Chỉ sửa package.json bên trong image.
RUN S3_SDK="$(node -p "require('./package.json').devDependencies['@aws-sdk/client-s3']")" \
 && npm pkg delete devDependencies \
 && npm pkg set "dependencies.@aws-sdk/client-s3=${S3_SDK}" \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=builder /app/dist ./dist

EXPOSE 3301
VOLUME ["/data/telemetry"]

# Gọi đúng địa chỉ server đang nghe (TELEMETRY_HOST); 0.0.0.0 / :: (mọi interface) → loopback.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD H="${TELEMETRY_HOST:-0.0.0.0}"; \
      case "$H" in 0.0.0.0|::|"") H=127.0.0.1 ;; *:*) H="[$H]" ;; esac; \
      wget -qO- "http://$H:${TELEMETRY_PORT}/health" >/dev/null || exit 1

CMD ["node", "dist/src/standalone.js"]
