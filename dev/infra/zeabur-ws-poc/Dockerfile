# POL-7 · Zeabur WS echo PoC 运行时（形态对齐 infra/updates-static：zbpack.json → dockerfile.path）
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY echo.ts ./
# Zeabur 平台终结 TLS（对外 wss），容器内为纯 WS；端口须与 Zeabur 控制台 Port 设置（8787 / HTTP）一致
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "run", "echo.ts"]
