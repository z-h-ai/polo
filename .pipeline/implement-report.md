# POO-14 实现报告

## 变更摘要

- 完成 Linux AppImage 安装路径的所有权封闭：
  - 安装前同时校验 `~/.polo-ai/app/current`、AppImage、终端 launcher 和 ownership state；不再把未知常规文件、目录或符号链接当作可升级的 Polo 安装。
  - 新增基于系统原子 rename primitive 的 no-replace helper。新 runtime、AppImage、回滚候选都以“不覆盖已存在目标”的方式发布，避免检查与移动之间的竞态覆盖用户文件。
  - transaction 内保留 helper 和安装包自带 Bun；安装、失败回滚及冲突留档不依赖用户预装 Bun，也不依赖已经移动的 runtime。
  - backup、publish、chmod 任一阶段失败都会核对 inode/hash 并恢复旧安装；遇到并发占用时保留用户目标和 rollback candidate，不递归跟随或删除用户 symlink。
- 将 canonical wrapper 的用户可见错误和 `polo-ai` 弃用提示统一到 shared locale JSON：
  - 新增生成脚本，产出 Unix/Windows wrapper 消息表，覆盖 `en/de/es/hu/ja/pl/zh-Hans`。
  - Unix、Windows 的 `polo`/`polo-ai` 不再维护手写翻译分支；兼容 shim 统一委托 canonical wrapper 输出本地化迁移提示。
  - CLI artifact build 会先生成消息表，`--check` 可阻止 locale 与 checked-in 产物漂移。
- 将生成消息表和 Linux 原子 helper 纳入 electron-builder、afterPack、最终容器校验、runtime smoke、Windows/Linux 安装器以及文档工具 wrapper fixture；缺失任一文件会使打包/验收失败。
- 补充 Linux 未受管 runtime/AppImage（常规文件与 symlink）、安装事务各失败点、7 locale wrapper、兼容 shim和 packaging contract 回归测试。
- 更新 next release notes，说明 Linux no-clobber 升级和 wrapper locale 单一来源。

## 关键文件列表

- `scripts/install-app.sh`
- `apps/electron/resources/scripts/linux-terminal-integration.sh`
- `apps/electron/resources/scripts/atomic-rename-no-replace.ts`
- `scripts/install-app-shell.test.ts`
- `scripts/linux-terminal-integration.test.ts`
- `apps/electron/resources/bin/polo`
- `apps/electron/resources/bin/polo.cmd`
- `apps/electron/resources/bin/polo-ai`
- `apps/electron/resources/bin/polo-ai.cmd`
- `apps/electron/resources/bin/polo-messages.sh`
- `apps/electron/resources/bin/polo-messages.cmd`
- `scripts/generate-wrapper-messages.ts`
- `scripts/__tests__/packaged-wrapper-i18n.test.ts`
- `scripts/validate-cli-artifacts.ts`
- `scripts/validate-cli-runtime.ts`
- `apps/electron/electron-builder.yml`
- `apps/electron/scripts/afterPack.cjs`
- `apps/electron/scripts/validate-final-artifacts.sh`
- `apps/electron/scripts/validate-final-artifacts.ps1`
- `apps/electron/resources/scripts/windows-terminal-integration.ps1`
- `packages/shared/src/i18n/locales/*.json`
- `apps/electron/resources/release-notes/next.md`

## 自测结果

- `bun run test`
  - 通过，主测试集及后续 isolated suites 全部退出 0；无 failed suite。
- POO-14 安装/包装器定向回归：
  - `bun test scripts/install-app-shell.test.ts scripts/linux-terminal-integration.test.ts scripts/uninstall-app.test.ts scripts/__tests__/packaged-wrapper-i18n.test.ts scripts/__tests__/electron-artifact-pipeline.test.ts apps/electron/scripts/windows-terminal-integration.test.ts`
  - `45 pass, 0 fail, 763 expect()`。
- `python3 -m unittest apps.electron.resources.scripts.tests.test_polo_wrapper_smoke`
  - `4 tests`，全部通过。
- `bun run test:doc-tools`
  - `23 tests`，全部通过。
- `bun run typecheck:all`
  - 通过。
- `bun run lint:i18n:parity`
  - 通过；7 个 locale 各 `1644` keys。
- `bun run lint:i18n:sorted`
  - 通过。
- `bun run lint:i18n:coverage`
  - 通过。
- `bun run lint:shared`
  - 通过，`0 errors`；9 条仓库既有 warnings。
- `bun run lint:electron`
  - 通过，`0 errors`；114 条仓库既有 warnings。
- `bun run electron:build`
  - 通过；CLI/server `0.10.0` 构建完成，packaged artifact validation 通过。
- `bun run electron:validate:cli:runtime`
  - 通过；覆盖 packaged discovery/server、自相对 symlink launcher、空格与非 ASCII 路径。
- `bun run scripts/generate-wrapper-messages.ts --check`
  - 通过；checked-in wrapper 消息表与 shared locale JSON 一致。
- `bash -n scripts/install-app.sh apps/electron/resources/bin/polo apps/electron/resources/bin/polo-ai apps/electron/resources/scripts/linux-terminal-integration.sh`
  - 通过。
- `git diff --check`
  - 通过。
- `atomic-rename-no-replace.ts` 本机 primitive smoke：
  - 首次 no-replace rename 成功；目标已存在时退出 `73` 且未覆盖目标。

## 遗留问题

- 当前机器是 macOS，不能原生完成 Linux AppImage 与 Windows NSIS 的真实安装、PATH、升级、运行、卸载全生命周期；本轮完成了 installer/helper 的 fixture 回归和打包门禁，最终仍须由对应平台的 blocking workflow 执行生产产物验收。
- 当前没有受控的固定 previous release artifact，未把 current artifact 冒充跨版本升级证据；previous → current 的真实三平台升级仍需 release workflow 使用固定旧产物验证。
- macOS/Windows 的正式签名、公证、安装后全新 Terminal，以及最终 DMG/ZIP、NSIS、AppImage 的生产发布验收依赖发布凭据与相应 runner，本地没有虚报完成。
