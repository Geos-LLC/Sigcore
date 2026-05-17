# Build stage
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Storage for encrypted account/session blobs + durable inbound event log
RUN mkdir -p /app/data/telegram-accounts /app/data/telegram-events

EXPOSE 3003
CMD ["node", "dist/main.js"]
