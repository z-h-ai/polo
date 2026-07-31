# POO-14 第 4 轮修复报告

## 变更摘要

- 将 Linux AppImage 的旧 `current`、旧 AppImage、新 runtime/AppImage 发布、可执行权限、shell profile、`polo`/`polo-ai` launcher 与 ownership state 收口到同一个延迟提交事务。
- 在事务激活后使用 `ERR`/`EXIT` trap 统一回滚。只有 runtime、AppImage、profile、launcher 和 state 的 identity/hash 校验全部成功后，才提交 terminal 子事务并删除旧候选。
- 为两个旧产物 backup `mv`、两个新产物 publish `mv` 和 AppImage `chmod` 增加真实 shell 故障注入回归。
- 补齐 canonical Unix wrapper 对仓库全部 7 个支持 locale（`en`、`de`、`es`、`hu`、`ja`、`pl`、`zh-Hans`）的缺失 runtime/terminal 文件错误文案和真实 wrapper 执行测试。

代码提交：

- `c103fae576adda0a13fb40e58ae27f8c3a41707c` — `POO-14: 原子化 Linux AppImage 升级事务`

## Reviewer issues 逐条处理

### 1. Blocking major：Linux App/runtime 备份与发布不在统一回滚事务

处理完成。

- `scripts/install-app.sh` 在修改已安装 App 前创建权限为 `0700` 的外层 `.install-transaction.*`，同时保存：
  - 旧 `current` 的 filesystem identity 与 package hash；
  - 旧 AppImage 的 filesystem identity 与完整 SHA-256；
  - 新 runtime 内 package、canonical wrappers、terminal helper 的 SHA-256；
  - 新 AppImage 的完整 SHA-256；
  - profile 的事务前后 identity/hash。
- 在任何旧备份移动前先完成两个旧产物的只读快照，避免第二个 backup `mv` 失败时缺少第一个候选的恢复依据。
- 从第一个已安装路径写操作开始启用 `set -E` 与统一 `ERR`/`EXIT` trap。备份 `mv`、发布 `mv`、`chmod`、profile 配置、terminal helper、最终校验任一点非零都会进入同一回滚函数。
- terminal helper 新增 deferred install：
  - 旧 launcher/state 候选保留在外层事务的 `terminal/` 子目录；
  - 新 state、launcher identity 写入权限为 `0600` 的 `INSTALL_PENDING`；
  - `commit-install` 重新验证完整 ownership state、两个 launcher 与绑定 profile 后才删除旧候选；
  - `rollback-install` 按记录的 identity/hash 恢复旧 launcher/state。
- App 回滚只删除与本事务记录的新 identity/hash 完全匹配的 current/AppImage，并且只在旧候选 identity/hash 与快照完全一致、目标位置未被并发占用时恢复。无法安全恢复时不覆盖并发文件，保留带 `ROLLBACK_REQUIRED` 的事务目录并返回冲突。
- 正常提交前再次验证：
  - current 目录 identity 与 package/wrapper/helper hashes；
  - AppImage identity、完整 hash 与 executable bit；
  - profile 的唯一精确托管块、identity 与 hash；
  - ownership state、`polo` 和 `polo-ai` launcher。
- 只有以上校验和 helper `commit-install` 全部成功后才禁用 rollback trap、清理旧 App/runtime/profile 候选和事务目录。

新增的确定性回归逐点注入：

1. 旧 `current -> current.previous` 的 backup `mv` 失败；
2. 旧 AppImage `-> Polo-AI.previous` 的 backup `mv` 失败；
3. 新 `squashfs-root -> current` 的 publish `mv` 失败；
4. 新下载 AppImage `-> Polo-AI-x64.AppImage` 的 publish `mv` 失败；
5. 新 AppImage `chmod +x` 失败。

每个 case 都先完成真实 fixture 首次安装，再执行失败的 upgrade，并断言：

- upgrade 非零退出且确实命中指定故障点；
- 旧 current 与旧 AppImage 的 inode identity 和内容逐项恢复；
- profile、ownership state、`polo`、`polo-ai` 内容/target 保持原样；
- launcher 仍是原受管 symlink；
- 没有 `.install-transaction.*`、`.profile-transaction.*`、`.terminal-install.*` 或 `.polo-extract.*` 残留。

### 2. Minor：canonical Unix wrapper locale 覆盖

安全、范围可控，已完成。

- `apps/electron/resources/bin/polo` 继续保持自相对解析和稳定错误码：
  - `POLO_E_BUNDLED_RUNTIME_MISSING`
  - `POLO_E_TERMINAL_FILES_MISSING`
- 在不依赖外部 runtime 的最小 wrapper 消息表中补齐 `de`、`es`、`hu`、`ja`、`pl`，保留 `en` fallback 与 `zh`。
- Bun 回归将 wrapper 复制到包含空格和非 ASCII 字符的 fixture root，逐个 locale 真实执行缺失 runtime 分支。
- Python doc-tool wrapper smoke 同时覆盖全部 locale 的 runtime 与 terminal-file 缺失分支，并保留未知 `fr` 回退英文检查。

## 关键文件

- `scripts/install-app.sh`
- `apps/electron/resources/scripts/linux-terminal-integration.sh`
- `scripts/install-app-shell.test.ts`
- `apps/electron/resources/bin/polo`
- `scripts/__tests__/packaged-wrapper-i18n.test.ts`
- `apps/electron/resources/scripts/tests/test_polo_wrapper_smoke.py`
- `apps/electron/resources/release-notes/next.md`

## 自测命令与真实结果

### 针对性回归

- `bash -n scripts/install-app.sh apps/electron/resources/scripts/linux-terminal-integration.sh apps/electron/resources/bin/polo`
  - 通过。
- `bun test scripts/install-app-shell.test.ts scripts/linux-terminal-integration.test.ts scripts/uninstall-app.test.ts scripts/__tests__/packaged-wrapper-i18n.test.ts scripts/__tests__/electron-artifact-pipeline.test.ts`
  - `40 pass / 0 fail`，`693 expect()`。
- 增加 inode identity 断言后再次执行：
  - `bun test scripts/install-app-shell.test.ts --test-name-pattern 'rolls back every'`
  - `1 pass / 0 fail`，`85 expect()`；五个故障点全部通过。
- `python3 -m unittest apps.electron.resources.scripts.tests.test_polo_wrapper_smoke`
  - `4 tests`，全部通过。
- `bun run test:doc-tools`
  - `23 tests`，全部通过。

### 全量门禁

- `bun run test`
  - exit `0`。
  - 主测试集：`4919 pass / 19 skip / 0 fail`，`12479 expect()`，380 files。
  - 后续所有 isolated suites 亦全部通过，包括 concurrent server cleanup、file-lock races、CLI server spawner、renderer interaction 和 main-process isolation suites。
- `bun run typecheck:all`
  - exit `0`。
- `bun run lint:shared`
  - exit `0`，`0 errors / 9 existing warnings`。
- `bun run lint:electron`
  - exit `0`，`0 errors / 114 existing warnings`。
- `bun run lint:i18n:parity`
  - 通过：6 个非英文 locale 与英文各 `1642` keys。
- `bun run lint:i18n:sorted`
  - 通过。
- `bun run lint:i18n:coverage`
  - 通过。
- `bun run electron:build`
  - exit `0`；CLI/server 0.10.0、Electron main/preload/renderer/resources/assets 均构建成功，packaged CLI artifacts validation 通过。
- `bun run electron:validate:cli:runtime`
  - exit `0`；packaged CLI/server discovery、安装 symlink 自相对 wrapper、空格/非 ASCII 路径运行全部通过。
- `git diff --check`
  - 通过。

## 回滚、竞态与残留检查

- 五个新增真实 shell 故障点均验证旧 App/runtime/profile/launcher/state 完整恢复，无 transaction/quarantine 残留。
- 既有 adversarial tests 继续覆盖：
  - launcher/state/profile 提交点并发占用；
  - helper failure；
  - profile regular-file、symlink、rename、content race；
  - corrupt/tampered ownership state；
  - 正常首次安装、repair、upgrade、uninstall。
- 全量测试完成后执行相关进程、监听端口和临时事务目录检查：
  - 未发现 `polo-server`、mock provider、Polo AppImage/App 相关遗留进程；
  - 未发现相关 Bun/Polo 监听端口；
  - 未发现 `.install-transaction.*`、`.profile-transaction.*`、`.terminal-install.*`、`.polo-extract.*` 或测试 runtime 文件残留。

## 仍需外部 release evidence

本轮在 macOS 主机完成源码、shell fixture、Electron build 和 packaged runtime 验证；没有声称以下外部证据已经完成：

- Linux runner 上的真实 AppImage full install/previous-to-current upgrade/discovery/commands/uninstall；
- Windows runner 上的真实 NSIS full install/previous-to-current upgrade/discovery/commands/uninstall；
- 可信、版本不同的 pre-POO-14 三平台 previous release assets；
- 生产 macOS Team ID/designated requirement/notarization/stapling 与 Windows Publisher/thumbprint 签名审计；
- 三平台 release/nightly full workflow 的成功日志、artifact hashes 与 signing audit。

这些仍必须由具备固定历史产物、生产签名身份和对应原生 runner 的 release/nightly workflow 提供。development/ad-hoc 构建不能替代 production/full release evidence。
