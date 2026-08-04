# POO-26 GitHub Actions 发布故障修复报告

## 变更摘要

- clean-consumer 的 Next production route proof 不再通过 `npm run start`
  生成不可控的 npm → Next 孙进程；现在直接以 Node 启动已安装的 Next CLI。
- proof 在请求真实 API route 后向 Next 子进程发送 `SIGTERM` 并等待 `close`；5 秒
  未退出才升级为 `SIGKILL`，再次等待退出。清理完成后移除 stdout/stderr listener
  并销毁两条 pipe，避免 Bun 事件循环被孙进程继承的 pipe 持有。
- 新增 CI 风格非交互生命周期回归入口。它以 piped stdio 和独立进程组启动完整
  clean-consumer proof，必须观察到 proof 命令自行 `exit 0`，并检查整个进程组已无
  活跃后代；watchdog 只会令测试失败并清理进程组，不是成功路径。
- package、publish manifest、lockfile、workflow、tarball/metadata/artifact 命名和
  POL-59 handoff 全部升级到 `0.11.1` / `shared-v0.11.1`。workflow 从 publish
  manifest 动态派生版本和 tarball 路径，proof、attestation、publish、metadata
  查询继续操作同一 tarball，job timeout 作为防御提高到 30 分钟。
- 文档记录 `shared-v0.11.0` 仍不可变地指向
  `27ec7083ecce131818b24026edef283eda10c380`；run `30870120001` 是 proof
  通过但因孤儿 Next 进程超时、未执行 attest/publish 的失败尝试。POL-59 后续必须
  消费 `0.11.1`，不得移动或复用 `shared-v0.11.0`。
- 未修改 Creator Skill canonical contract、fixture 或 digest 算法。

## 关键文件

- `packages/shared/scripts/verify-creator-skills-package.ts`
- `packages/shared/scripts/verify-creator-skills-package-lifecycle.ts`
- `packages/shared/package.json`
- `packages/shared/package.publish.json`
- `bun.lock`
- `.github/workflows/publish-shared-package.yml`
- `docs/shared-package-publishing.md`
- `.pipeline/implement-report.md`

## 实际自测

### Shared 全量测试

```sh
bun run --cwd packages/shared test
```

结果：通过，`3021 pass / 18 skip / 0 fail`，共 3039 tests、6914
assertions，170 files。fixture/canonical tests 未出现漂移。

### 相关类型检查

```sh
bunx tsc --noEmit --strict --target ESNext --module ESNext \
  --moduleResolution bundler --types bun --skipLibCheck \
  packages/shared/scripts/verify-creator-skills-package.ts \
  packages/shared/scripts/verify-creator-skills-package-lifecycle.ts \
  packages/shared/scripts/stage-creator-skills-package.ts
bun run --cwd packages/shared tsc --noEmit
```

结果：均通过。第一条显式覆盖默认 shared tsconfig 未包含的 proof scripts；第二条
覆盖 shared 源码。

### 完整 clean-consumer 与进程退出回归

```sh
proof_output="$(mktemp -d /tmp/z-h-ai-shared-evidence.XXXXXX)"
bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts \
  --allow-dirty-snapshot --output-dir "$proof_output"
```

结果：通过。生命周期 wrapper 强制 `CI=1`、stdin ignored、stdout/stderr piped；
`lifecycle-proof.json` 记录 proof 命令自行 `exitCode: 0`、无退出 signal、完整进程组
已回收且没有活跃后代。`proof.json` 记录：

- package：`@z-h-ai/shared@0.11.1`
- tarball：`z-h-ai-shared-0.11.1.tgz`
- SHA-256：`d4e3dc2e00967410d1abe16e68f9b439d0a897e120d71d7efc577e4b78b7b9b2`
- npm integrity：
  `sha512-Kitxxhd0L9VPQPBZE0LR5r+FZCoDxpiYaUNI5Qb/OEUuWCxY446JNFzmG4/zejm8Xf4K56Q4daD74UA71BzXdw==`
- Next：Node 直接启动 CLI，`SIGTERM` 后 5ms 退出，`forcedKill: false`
- Node CJS/ESM、unsupported subpaths、TypeScript 6.0.3、Next.js 16.2.7
  Turbopack build、真实 route、tarball 负向边界全部通过
- canonical fixture digest：
  `f9999556728593a5f0f5f3e22f89b1e86793ae5232f7e11e68324ef82927136c`

`--allow-dirty-snapshot` 只跳过实现阶段尚未 commit 时的 Git tracked-status 门禁；
clean consumer 仍在仓库外临时目录中从 tarball 创建 lockfile、删除 `node_modules`
后执行 frozen `npm ci`，生命周期与全部消费验证没有跳过。正式 workflow 不传该参数，
会继续要求 checkout snapshot clean/reproducible。

### Workflow、版本与基础一致性

```sh
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/publish-shared-package.yml')"
node -e "const a=require('./packages/shared/package.json'); const b=require('./packages/shared/package.publish.json'); if(a.version!=='0.11.1'||a.version!==b.version) process.exit(1)"
git rev-parse 'shared-v0.11.0^{}'
git diff --check
```

结果：通过；旧 tag 仍解析到
`27ec7083ecce131818b24026edef283eda10c380`，未被删除或移动。

## 遗留发布门禁

- 按 coder 纪律未执行 push、tag 或 publish；本 commit 也不会创建
  `shared-v0.11.1`。
- 授权方仍需在 review 通过后创建并 push `shared-v0.11.1`，等待 workflow 完整完成
  proof → attestation → 同一 tarball publish → registry metadata → artifact upload。
- 必须确认 `@z-h-ai/shared@0.11.1` 的 GitHub Packages metadata/integrity 与本次
  workflow 产物一致，并授予 `z-h-ai/polo-admin` Actions read access。
- POL-59 仍需固定消费 `0.11.1`，执行 authenticated registry-backed frozen
  `npm ci`、Node/TypeScript/Next/真实 `/api/capabilities` 及其数据库、对象存储、角色、
  Electron ledger/journal 独立验收。完成本修复不等于 registry 发布或 POL-59 验收完成。
