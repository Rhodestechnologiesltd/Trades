# Multi-stage build for the API and the background worker (same image, different command).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/domain/package.json packages/domain/
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/
RUN npm install -w @trades/domain -w @trades/backend
COPY tsconfig.base.json ./
COPY packages/domain packages/domain
COPY backend backend
RUN npm run build -w @trades/domain && npm run build -w @trades/backend

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/domain ./packages/domain
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/migrations ./backend/migrations
COPY --from=build /app/backend/package.json ./backend/package.json
USER app
WORKDIR /app/backend
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "dist/src/main.js"]
