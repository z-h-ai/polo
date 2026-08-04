# POO-26 Reviewer Round 1 修复报告

## Issue 1：Next 提前退出后 route 轮询未取消

### 修复

- 将 route polling 与子进程生命周期提取到
  `packages/shared/scripts/managed-route-process.ts`。
- `waitForRoute` 现在接收 `AbortSignal`。外部取消会同时中止进行中的 `fetch`、500ms
  retry sleep、120 秒整体 timer 和后续轮询；所有 timer 与 abort listener 均在
  `finally` 清理。
- Next `close`、spawn `error` 或外层 `finally` 会立即 abort route polling，并等待
  route promise 完成清理后再退出。
- 提前退出仍抛出原始错误
  `Next production server exited before the proof route responded`；spawn 失败保留原始
  `ENOENT` 和失败 command path，不会被 cleanup 错误替换。
- 子进程的 `error`/`close` 与 stdout/stderr listener 均显式移除，pipe 均销毁；正常
  route proof 仍执行 TERM → 等待 → 超时 KILL 的清理流程。

### 自动回归

新增：

- `proof-failure-lifecycle-worker.ts`：构造 Next 等价子进程立即 `exit 23` 和 executable
  `ENOENT` 两条失败路径。
- `verify-proof-failure-lifecycle.ts`：在父进程中以 piped stdio 和独立进程组执行 worker，
  只有被测命令自行退出才通过；5 秒 watchdog 仅作为失败/清理路径，不是 shell
  timeout 或成功条件。两条路径都检查短上限和无存活后代。
- workflow 在完整 package proof 前自动执行
  `test:creator-skills-package-failures`。

实际命令：

```sh
bun run --cwd packages/shared test:creator-skills-package-failures
```

结果：通过。

- early exit 23：7ms 内保留原始 early-exit 错误并自行退出，无后代。
- Next executable ENOENT：5ms 内保留原始 code/path 并自行退出，无后代。

## Issue 2：wrapper spawn ENOENT 被 pid assertion 覆盖

### 修复

- lifecycle wrapper 的 `spawn` 进入统一 `try/finally` 后，立即注册 `error`/`close`
  listener，再处理 pid。
- pid 缺失时先等待 spawn outcome；因此 PATH 中不存在 `bun` 时抛出原始 `ENOENT`，
  不再先抛 `proof process did not receive a pid`。
- process group 只在取得真实 pid 后创建/清理；无 pid 的 spawn failure 不执行负 pid
  signal。
- `finally` 无条件清理 watchdog、child listeners、stdout/stderr streams，以及 wrapper
  自动创建的 temp output directory。

### 自动回归

同一 failure lifecycle regression 使用绝对 Bun 启动 wrapper，但把 wrapper 的
`PATH` 指向空目录且不传 `--output-dir`，验证其内部 `spawn('bun')` 失败：

- 13ms 内自行 `exit 1`；
- stderr 保留 `ENOENT`，不包含 pid assertion；
- 自动 temp root 清空；
- 整个进程组无存活后代。

## 完整验证

### 成功 lifecycle wrapper 与 clean consumer

```sh
proof_output="$(mktemp -d /tmp/z-h-ai-shared-round1.XXXXXX)"
bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts \
  --allow-dirty-snapshot --output-dir "$proof_output"
```

结果：通过。proof 命令自行 `exit 0`，进程组无后代；Node CJS/ESM、TypeScript、
Next.js 16.2.7 Turbopack build、真实 route 和 tarball 边界全部通过。Next 正常
`SIGTERM` 后 4ms 退出，`forcedKill: false`。

- package：`@z-h-ai/shared@0.11.1`
- tarball SHA-256：
  `d4e3dc2e00967410d1abe16e68f9b439d0a897e120d71d7efc577e4b78b7b9b2`
- canonical fixture digest 保持：
  `f9999556728593a5f0f5f3e22f89b1e86793ae5232f7e11e68324ef82927136c`

`--allow-dirty-snapshot` 只跳过 commit 前 tracked-status 门禁；wrapper 本身仍强制
`CI=1`、非交互 piped stdio，clean consumer 仍在仓库外执行 frozen `npm ci`。

### Proof scripts strict TypeScript 与 shared typecheck

```sh
bunx tsc --noEmit --strict --target ESNext --module ESNext \
  --moduleResolution bundler --types bun --skipLibCheck \
  --allowImportingTsExtensions \
  packages/shared/scripts/managed-route-process.ts \
  packages/shared/scripts/verify-creator-skills-package.ts \
  packages/shared/scripts/verify-creator-skills-package-lifecycle.ts \
  packages/shared/scripts/proof-failure-lifecycle-worker.ts \
  packages/shared/scripts/verify-proof-failure-lifecycle.ts \
  packages/shared/scripts/stage-creator-skills-package.ts
bun run --cwd packages/shared tsc --noEmit
```

结果：均通过。

### Shared tests

```sh
bun run --cwd packages/shared test
```

结果：`3021 pass / 18 skip / 0 fail`，3039 tests、6914 assertions、170 files。

### 版本、workflow、tag 与 diff

```sh
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/publish-shared-package.yml')"
node -e "const a=require('./packages/shared/package.json'); const b=require('./packages/shared/package.publish.json'); if(a.version!=='0.11.1'||a.version!==b.version) process.exit(1)"
git rev-parse 'shared-v0.11.0^{}'
git diff --check
```

结果：全部通过。package/publish manifest 仍为 `0.11.1`，handoff/workflow 目标仍为
`shared-v0.11.1`；旧 `shared-v0.11.0` tag 仍指向
`27ec7083ecce131818b24026edef283eda10c380`，未移动。

## 遗留门禁

- 本轮未执行 push、tag 或 publish。
- `shared-v0.11.1` 创建、GitHub Actions attest/publish/metadata/artifact、package access
  grant，以及 POL-59 registry-backed frozen install 仍需 review 通过后由授权流程执行。
