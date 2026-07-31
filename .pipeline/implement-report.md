# POO-16 实现报告

## 变更摘要

本轮定向补齐 Electron 安装包的独立 CLI 入口与真实 payload 链路：

1. 新增 Unix/macOS/Linux `polo` 与 Windows `polo.cmd` 主 launcher；两者从自身所在的 Electron `Resources/app/resources/bin` 布局推导 app root、sidecar Bun、CLI bundle 和 server bundle，不依赖调用方预设环境变量。
2. `polo-ai` 与 `polo-ai.cmd` 保留为兼容别名，分别直接转发给同目录的 `polo` / `polo.cmd`，确保两个命令执行同一实现。
3. Electron build 在 renderer/main/resources 组装前生成 `dist/cli/polo-cli.js`、`dist/server/polo-server.js`、双 bin 元数据和带 SHA-256 的 artifact manifest；CLI 启动 server 时使用 launcher 注入的 bundled Bun 与 server 路径。
4. electron-builder 将四个 launcher、CLI/server payload 和各平台 Bun sidecar 纳入实际 Resources 布局；beforePack 校验源组装输入，afterPack 校验真实 package output 的路径、版本、manifest 哈希及双入口契约。
5. macOS/Linux Electron 自身的 bundled Bun 解析同步到新的 `Resources/vendor/bun` sidecar 布局，避免为 CLI 调整资源位置后破坏 Electron 正常 runtime。
6. 新增三平台 assembled-layout 回归、Unix launcher 执行回归、缺失 payload fail-fast 回归、packaged server/Bun 发现回归和 packaged runtime mode 回归。

## 关键文件

- `apps/electron/resources/bin/polo`、`polo.cmd`：自定位主 launcher。
- `apps/electron/resources/bin/polo-ai`、`polo-ai.cmd`：调用主 launcher 的兼容别名。
- `scripts/build-cli-artifacts.ts`：生成独立 CLI/server bundle、双 bin 元数据和校验 manifest。
- `scripts/validate-cli-artifacts.ts`：源码 launcher 与生成 artifact 的 build 后验证。
- `apps/electron/scripts/packaged-cli-layout.cjs`：electron-builder 输入及最终 Resources 布局验证。
- `apps/electron/scripts/beforePack.cjs`、`afterPack.cjs`：接入 electron-builder 生命周期。
- `apps/electron/electron-builder.yml`：打包四个入口、CLI/server payload 与平台 Bun sidecar。
- `apps/cli/src/server-spawner.ts`：packaged server artifact 发现、bundled Bun 启动和 packaged env 传递。
- `apps/electron/src/main/local-app-runtime/runtime-paths.ts`：Electron 与 CLI 共用 packaged Bun sidecar 路径。
- `apps/electron/scripts/packaged-cli-layout.test.ts`、`apps/cli/src/server-spawner.packaged.test.ts`：assembled artifact 和 runtime 回归。

## 实际验证与结果

- `bun test apps/cli/src/server-spawner.packaged.test.ts apps/electron/scripts/packaged-cli-layout.test.ts apps/electron/src/main/local-app-runtime/__tests__/runtime-paths.test.ts packages/session-tools-core/src/runtime/resolve-script-runtime.test.ts`
  - 22 pass，0 fail。
- `bun run electron:build`
  - 通过；生成 CLI/server bundle，完成 Electron main/preload/renderer/resources build，并通过 CLI `--version` artifact 校验。
- `bun run server:build:subprocess`
  - 通过；Session MCP 与 Pi Agent subprocess 均成功构建。
- `bun run typecheck:all`
  - 通过；core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部退出码为 0。
- `bun run test`
  - 通过；主测试与全部 `*.isolated.ts` 测试退出码为 0。
- `git diff --check`
  - 通过。
- `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir --arm64`
  - 通过；执行 beforePack/afterPack，afterPack 输出 `Packaged polo and polo-ai launchers validated (0.10.0)`。
  - 在实际 unsigned `.app` 组装目录中确认四个 launcher、CLI bundle、server bundle、manifest 与 `Resources/vendor/bun/bun` 均存在。
  - 直接执行实际组装产物内的 `polo --version` 与 `polo-ai --version`，二者均输出 `0.10.0`。
  - 验证后的 unsigned package directory 已移出 worktree，保存在 `/tmp/polo-poo16-packaged-layout-final-20260731`。

## 未验证项与遗留风险

- 未执行签名、notarization、DMG 安装、NSIS 安装或 AppImage 安装测试；不对这些安装流程作已验证声明。
- Windows/Linux 最终安装介质未在对应系统实机运行；其结构、alias、缺失 payload 和 runtime 路径由三平台 assembled-layout 测试及 electron-builder hook 覆盖，Windows `.cmd` 仍需 Windows 实机安装验收。
- 本轮没有引入 POO-14 的设置 UI、terminal integration、安装/卸载或升级逻辑。
