# Polo AI 开发指引

本文件是仓库级开发指引的唯一主文档；`CLAUDE.md` 是指向本文件的相对软链接。
目录级指引同样以各自的 `AGENTS.md` 为主，修改时只维护主文档。

## 按修改范围阅读

- Electron 主进程、preload、renderer：[apps/electron/AGENTS.md](apps/electron/AGENTS.md)。
- 公共类型与轻量工具：[packages/core/AGENTS.md](packages/core/AGENTS.md)。
- Agent、配置、凭据、会话与国际化：[packages/shared/AGENTS.md](packages/shared/AGENTS.md)。
- `packages/server-core/` 负责 RPC 和会话管理；`packages/pi-agent-server/` 负责 Pi 子进程。
- 打包资源目录的专用说明见 `apps/electron/resources/AGENTS.md`。

## 常用命令

以下命令在仓库根目录执行，具体定义以 `package.json` 为准：

- 开发：`bun run electron:dev`。
- 构建：`bun run electron:build`。
- 测试：`bun run test`；单文件检查可用 `bun test <test-file>`。
- CLI runtime：`bun test apps/cli/src/runtime*.test.ts apps/cli/src/managed-provenance.integration.test.ts packages/server-core/src/sessions/cli-execution-authority.test.ts`（真实 server + Pi worker；应为 0 fail）。
- CLI managed：`bun test apps/cli/src/managed-controlled.integration.test.ts apps/cli/src/managed-lifecycle.integration.test.ts packages/shared/src/credentials/__tests__/desktop-managed-proxy.test.ts`（真实 Broker/proxy/Admin client + HTTP fixtures；应为 0 fail，不能作为真实计费验收）。
- 类型检查：`bun run typecheck:all`。
- Lint：`bun run lint`。

## 来源与验证

- 安装与启动说明见 `README.md`，目录内的具体约定见上述开发指引。
- 客户端产品规则见 `docs/client-journey-review/spec.md`；UI 任务读取
  `.agents/skills/polo-ai-design-system/SKILL.md` 并核对适用范围与来源绑定。
- 按改动范围运行检查，分别报告代码检查、实际运行和产品验收结果。

## 基础设施与域名（z-h-ai.com）

涉及子域名、DNS、腾讯轻量服务器（gz-coolify-main，111.230.240.195）、Coolify、部署链路的改动，动手前必读：

- 硬性规则（skill）：`~/.agents/skills/z-h-ai-infra/SKILL.md`。
- 完整运维手册：`~/zeabur-migration/INFRA-PLAYBOOK.md`。

核心三条：新子域名必须"双登记"（阿里云 alidns 生效解析 + 腾讯 DNSPod 登记，缺一可能被腾讯侧拦截）；CI 部署走 `https://deploy.z-h-ai.com` + token，禁止回退 SSH 传输；禁止给腾讯 CWP 加地区登录白名单（会把真实入侵静音）。
