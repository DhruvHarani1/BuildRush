# syntax=docker/dockerfile:1
# Base image pinned by digest (node:22-slim); Dependabot's docker ecosystem bumps tag and digest together.
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
COPY bin ./bin
RUN npm run build && npm prune --omit=dev

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
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
