# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.20.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /build
RUN chown 1000:1000 /build
USER 1000:1000
COPY --chown=1000:1000 .node-version package.json package-lock.json ./
# Fail before installation if a build argument drifts from the repository pin.
RUN node --input-type=module -e "import {readFileSync} from 'node:fs'; if(process.versions.node !== readFileSync('.node-version','utf8').trim()) process.exit(1)"
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY --chown=1000:1000 tsconfig.json vitest.config.ts LICENSE ./
COPY --chown=1000:1000 src/ ./src/
COPY --chown=1000:1000 test/unit/ ./test/unit/
COPY --chown=1000:1000 scripts/build-node.mjs scripts/smoke-node.mjs ./scripts/
COPY --chown=1000:1000 docs/node-runtime.md ./docs/node-runtime.md
RUN npm run check && npm run build:node && npm run test:node-build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="geobs-mcp" \
      org.opencontainers.image.description="Read-only GeoBS MCP server for Node.js" \
      org.opencontainers.image.source="https://github.com/meulth/geobs-mcp" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production \
    GEOBS_BIND_ADDRESS=0.0.0.0 \
    GEOBS_CATALOG_PATH=/var/lib/geobs-mcp/catalog/ogc-catalog.v1.json
# The bundles are self-contained: package managers are attack surface only.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir -p /var/lib/geobs-mcp/catalog && chown -R 1000:1000 /var/lib/geobs-mcp
# Only the bundles, their licenses and build metadata enter the runtime.
COPY --from=build /build/dist/node/ ./
USER 1000:1000
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["node"]
CMD ["/app/server.mjs"]
