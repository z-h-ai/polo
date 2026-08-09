FROM oven/bun:1.3.10-alpine AS dependencies

WORKDIR /app
COPY infra/updates-static/package.json ./package.json
RUN bun install --production --no-save

FROM oven/bun:1.3.10-alpine AS bun-runtime

FROM caddy:2.10-alpine

RUN apk add --no-cache libgcc libstdc++

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=dependencies /app/node_modules /app/node_modules
COPY scripts/electron-release-contract.ts /app/electron-release-contract.ts
COPY scripts/publish-electron-release.ts /app/publish-electron-release.ts
COPY scripts/polo-release-pull.ts /app/polo-release-pull.ts
COPY scripts/strict-semver.ts /app/strict-semver.ts
COPY scripts/strict-semver-pattern.txt /app/strict-semver-pattern.txt
COPY infra/updates-static/polo-release-pull /app/polo-release-pull

COPY infra/updates-static/PoloCaddyfile /etc/caddy/Caddyfile

EXPOSE 8080
