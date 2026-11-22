# syntax=docker/dockerfile:1
# TODO(maintainer): pin both FROM lines by digest (see docs/MAINTAINER_CHECKLIST.md).
FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
COPY bin ./bin
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
LABEL org.opencontainers.image.source="https://github.com/DhruvHarani1/BuildRush" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="BuildRush: local-first incremental build and test engine"
WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/bin ./bin
COPY --from=build /src/dist/src ./dist/src
# Runs as the unprivileged built-in "node" user (never root). Mount your project at /workspace.
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/app/bin/buildrush.js"]
CMD ["--help"]
