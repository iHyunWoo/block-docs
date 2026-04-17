############################
# Base image — deps layer
############################
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund

############################
# Dev target — next dev with polling for bind mounts
############################
FROM node:20-alpine AS dev
WORKDIR /app
ENV NODE_ENV=development
ENV WATCHPACK_POLLING=true
ENV CHOKIDAR_USEPOLLING=true
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json next.config.mjs .eslintrc.json next-env.d.ts ./
COPY src ./src
COPY public ./public
EXPOSE 3000
CMD ["npm", "run", "dev"]

############################
# Build stage — prod build
############################
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json next.config.mjs .eslintrc.json next-env.d.ts ./
COPY src ./src
COPY public ./public
RUN npm run build

############################
# Base / prod image — next start
############################
FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY package.json next.config.mjs ./
EXPOSE 3000
CMD ["npm", "run", "start"]
