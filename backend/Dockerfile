FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY backend backend
RUN npm run build -w backend

FROM node:22-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 TRUST_PROXY=true
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace=backend --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
COPY backend/migrations backend/migrations
WORKDIR /app/backend
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
