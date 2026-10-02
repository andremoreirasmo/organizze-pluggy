# syntax=docker/dockerfile:1

FROM node:22-alpine AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS api-build
WORKDIR /app/api
COPY api/package*.json ./
RUN npm ci
COPY api/ ./
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY api/package*.json ./api/
COPY api/prisma ./api/prisma
WORKDIR /app/api
RUN npm ci --omit=dev && npx prisma generate
COPY --from=api-build /app/api/dist ./dist
COPY --from=web-build /app/web/dist /app/web/dist
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/main.js"]
