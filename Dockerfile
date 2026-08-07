FROM --platform=linux/amd64 alpine:3.18

WORKDIR /app

RUN apk add --no-cache libstdc++

COPY --chmod=755 infra/polo-public/runtime/polo-public-api /app/polo-public-api
COPY apps/viewer/dist apps/viewer/dist
COPY scripts/install-app.sh scripts/install-app.ps1 scripts/

ENV NODE_ENV=production
ENV VIEWER_DIST_DIR=/app/apps/viewer/dist
ENV INSTALL_SCRIPTS_DIR=/app/scripts

EXPOSE 3000

CMD ["/app/polo-public-api"]
