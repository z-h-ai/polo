# Test Resource Lifecycle (trl) 采用说明

本仓库已接入 [test-resource-lifecycle](https://github.com/z-h-ai/test-resource-lifecycle) v1.0.3。
运行时所有权、信号转发、清理、恢复与 sweeping 由固定的 `trl` zipapp 负责,仓库内不做内联清理脚本。

## 跟踪文件

- `.test-resource-lifecycle.json` —— `policy_version: 1`、`repository_id: polo`、命名 profiles。
- `.test-resource-lifecycle.lock.json` —— 固定 v1.0.3 不可变 release URL、source commit、SHA-256。
- `scripts/trl` —— 可执行 bootstrap:校验 lock、下载/校验/缓存 zipapp(缓存在 `~/.cache/test-resource-lifecycle/<version>/`)。

## 本地用法

```bash
bash scripts/trl doctor                 # 环境自检(docker/compose/python)
bun run test                            # unit-test profile:单元测试
bun run test:doc-tools                  # doc-tools profile:python unittest
bun run electron:e2e:phone-auth         # e2e-phone-auth profile:trl 起 postgres 容器,
                                        #   注入 POL53_E2E_DATABASE_URL,不再依赖 localhost 共享库
bash scripts/trl run --profile=docker-smoke -- bash scripts/docker-smoke-test.sh <image:tag>
                                        # docker smoke(资源由脚本自身 trap 管理,见下)
bash scripts/trl sweep --repo=polo      # 清理死 owner 的受管资源
bash scripts/trl audit --repo=polo      # 查看 ledger
```

## 受管资源

| Profile | 资源 | 所有权依据 |
|---|---|---|
| `e2e-phone-auth` | PostgreSQL 容器 + 数据卷(policy-v1 标签 + 全局 ledger) | trl 创建,注入 `com.z-h-ai.test.*` 标签 |

CI(validate.yml / validate-server.yml / publish-shared-package.yml / electron-artifact-full.yml):
测试前 `scripts/trl sweep --repo=polo`,测试经 `scripts/trl run --profile=...` 包装,
`always()` 步骤上传 `.pipeline/test-resource-runs/**/cleanup-report.json`。

## v1 覆盖之外的资源(未受管,保留原样)

- `scripts/docker-smoke-test.sh` 启动的容器:脚本自身 `trap cleanup` + `docker rm -f`,
  无 policy-v1 标签与 ledger。无法证明所有权,不在 trl 接管范围,保持既有行为。
- electron-artifact-full.yml 的 Windows smoke/parser 步骤与各平台 `electron:dist:*`
  构建步骤(raw 命令,release 构建产物与 runner 临时目录由工作流自身管理)。
- electron-release.yml 为纯远程编排(GitHub Release / Zeabur),无本地测试资源。