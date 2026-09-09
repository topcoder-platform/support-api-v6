# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=26.5.1
ARG ALPINE_VERSION=3.24
ARG NODE_PACKAGE_VERSION=26.5.1-r0
ARG OPENSSL_PACKAGE_VERSION=3.5.8-r0
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
COPY patches ./patches
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
COPY patches ./patches
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN pnpm install --prod --frozen-lockfile \
  && SUPPORT_DATABASE_URL="postgresql://user:pass@localhost:5432/topcoder?schema=support" prisma generate

FROM alpine:${ALPINE_VERSION} AS production
ARG NODE_PACKAGE_VERSION
ARG OPENSSL_PACKAGE_VERSION
RUN apk upgrade --no-cache \
  && apk add --no-cache \
    "libcrypto3=${OPENSSL_PACKAGE_VERSION}" \
    "libssl3=${OPENSSL_PACKAGE_VERSION}" \
    "nodejs-current=${NODE_PACKAGE_VERSION}" \
  && addgroup -S node \
  && adduser -S -G node node
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY --from=build --chown=node:node /usr/src/app/dist ./dist
COPY --from=production-dependencies --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=node:node /usr/src/app/prisma ./prisma
COPY --from=build --chown=node:node /usr/src/app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=node:node /usr/src/app/package.json ./package.json
COPY --from=build --chown=node:node --chmod=755 /usr/src/app/appStartUp.sh ./appStartUp.sh
USER node
EXPOSE 3000
CMD ["./appStartUp.sh"]
