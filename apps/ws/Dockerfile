# syntax=docker/dockerfile:1.7

# ---------- base image with deps ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
# No lockfile yet — use npm install. If a lockfile is added later, swap to npm ci.
RUN npm install --no-audit --no-fund

# ---------- dev stage (tsx watch) ----------
FROM node:20-alpine AS dev
WORKDIR /app
# Non-root user. node:20-alpine ships a 'node' user with uid 1000.
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN chown -R node:node /app
USER node
EXPOSE 4000
CMD ["npm", "run", "dev"]

# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# ---------- prod deps (strip dev) ----------
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---------- runtime ----------
FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN chown -R node:node /app
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
