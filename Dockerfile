# --- Stage 1: Build ---
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

# --- Stage 2: Runner ---
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV TELEMETRY_PORT=3301
ENV TELEMETRY_STORAGE_DIR=/data/telemetry

COPY package*.json ./
RUN npm install --only=production --no-audit --no-fund

COPY --from=builder /app/dist ./dist

EXPOSE 3301
VOLUME ["/data/telemetry"]

CMD ["node", "dist/src/standalone.js"]