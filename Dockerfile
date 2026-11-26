# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=26.13.1
ARG ALPINE_VERSION=3.24
# Minimum secure package versions; Alpine repositories replace older revisions.
ARG NODE_PACKAGE_VERSION=26.13.1
ARG OPENSSL_PACKAGE_VERSION=3.5.9-r1
ARG PNPM_VERSION=11.20.0

FROM node:${NODE_VERSION}-alpine AS tooling
ARG PNPM_VERSION
RUN apk upgrade --no-cache && apk add --no-cache 'zlib>=1.4-r0' git openssh-client
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /usr/src/app

FROM tooling AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tools ./tools
COPY patches ./patches
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN SUPPORT_DATABASE_URL="postgresql://user:pass@localhost:5432/topcoder?schema=support" pnpm install --frozen-lockfile
RUN SUPPORT_DATABASE_URL="postgresql://user:pass@localhost:5432/topcoder?schema=support" pnpm exec prisma generate

FROM tooling AS build
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
COPY . .
RUN pnpm run test:dependency-compat
RUN pnpm lint && pnpm test --runInBand && pnpm build

FROM tooling AS production-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tools ./tools
COPY patches ./patches
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN pnpm install --prod --frozen-lockfile \
  && SUPPORT_DATABASE_URL="postgresql://user:pass@localhost:5432/topcoder?schema=support" pnpm exec prisma generate \
  && node -e "require('node:assert/strict').equal(require('@prisma/client').Prisma.prismaVersion.client, require('@prisma/client/package.json').version)"

FROM alpine:${ALPINE_VERSION} AS production
ARG NODE_PACKAGE_VERSION
ARG OPENSSL_PACKAGE_VERSION
RUN apk upgrade --no-cache \
  && apk add --no-cache 'zlib>=1.4-r0' \
    "libcrypto3>=${OPENSSL_PACKAGE_VERSION}" \
    "libssl3>=${OPENSSL_PACKAGE_VERSION}" \
    "nodejs-current~${NODE_PACKAGE_VERSION}" \
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
