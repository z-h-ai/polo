# POO-36 实现报告

## 变更摘要

- Tag 发布工作流现在要求 macOS x64、macOS arm64、Linux x64 与 Windows x64 全部构建成功；Windows 生成未签名的 NSIS `.exe`，并显式校验其 `NotSigned` 状态。
- Draft GitHub Release 收集 9 个受控资产，生成 schema v2 `release-contract.json`，其中包含两个 macOS DMG 和 Windows 安装包的 SHA-256；仍可读取线上旧 schema v1 合约作为前序版本。
- `production` 审批后通过 Zeabur Service Exec 调用 `updates-static-v4` 容器内的 `/app/polo-release-pull`。下载器只读取 Draft Release 的固定白名单，校验 tag/commit、所有 SHA-256、manifest SHA-512/大小后才调用现有原子发布器。
- 公网校验覆盖所有合约资产；成功后才将 Draft GitHub Release 转为正式发布。下载或校验失败不会切换 `electron/latest`。
- `updates-static` 镜像包含 Bun 下载器和最小依赖，Caddy 仍仅暴露既有 8080 静态端口；`install-app.sh`、manifest 与 contract 都使用 `no-cache`。

## 关键文件

- `.github/workflows/electron-artifact-full.yml`
- `.github/workflows/electron-release.yml`
- `scripts/electron-release-contract.ts`
- `scripts/electron-release-bundle.ts`
- `scripts/publish-electron-release.ts`
- `scripts/polo-release-pull.ts`
- `infra/updates-static/Dockerfile`
- `infra/updates-static/polo-release-pull`

## 自测结果

- `NO_COLOR=1 bun test scripts/electron-release-contract.test.ts scripts/electron-release-bundle.test.ts scripts/publish-electron-release.test.ts scripts/polo-release-pull.test.ts scripts/electron-release-workflow.test.ts`
  - 通过：29 tests、97 expects、0 fail。
- `docker build -f infra/updates-static/Dockerfile -t polo-updates-static-poo36:test .`
  - 通过；随后以 `/app/polo-release-pull` 启动镜像，确认 Bun 运行时、下载器入口与 `GH_TOKEN` fail-closed 前置检查可用。
- `git diff --check`
  - 通过。

## 遗留问题

- 首次真实 tag 联调前，仍需按任务前置授权在 GitHub `production` 配置 Zeabur Service Exec 所需 secret/vars，并在 `updates-static-v4` 配置仅限 `z-h-ai/polo` 只读的 `GH_TOKEN`。
- 本地卷当前预计使用率高于发布器 70% 阈值；下载器集成测试使用临时注入的容量检查，生产下载器不会绕过该阈值。
