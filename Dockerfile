ARG NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim-linuxarm64

FROM ${NODE_IMAGE} AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,id=h3-studio-npm-cache,target=/root/.npm \
    npm ci --prefer-offline --fetch-retries=5 --fetch-retry-factor=2 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=60000

COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist

USER node
EXPOSE 5174

CMD ["node", "server-dist/server/index.js"]
