# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.23.1
ARG PNPM_VERSION=11.20.0
ARG PRISMA_VERSION=7.9.1

FROM node:${NODE_VERSION}-alpine AS tooling
ARG PNPM_VERSION
ARG PRISMA_VERSION
RUN apk upgrade --no-cache && apk add --no-cache git openssh-client
RUN npm install --global pnpm@${PNPM_VERSION} prisma@${PRISMA_VERSION}
WORKDIR /usr/src/app

FROM tooling AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN SUPPORT_DATABASE_URL="postgresql://user:pass@localhost:5432/topcoder?schema=support" pnpm install --frozen-lockfile
RUN SUPPORT_DATABASE_URL="postgresql://user:pass@localhost:5432/topcoder?schema=support" prisma generate

FROM tooling AS build
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
COPY . .
RUN pnpm lint && pnpm test --runInBand && pnpm build

FROM tooling AS production-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN pnpm install --prod --frozen-lockfile \
  && SUPPORT_DATABASE_URL="postgresql://user:pass@localhost:5432/topcoder?schema=support" prisma generate

FROM node:${NODE_VERSION}-alpine AS production
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY --from=build --chown=node:node /usr/src/app/dist ./dist
COPY --from=production-dependencies --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=node:node /usr/src/app/prisma ./prisma
COPY --from=build --chown=node:node /usr/src/app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=node:node /usr/src/app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
