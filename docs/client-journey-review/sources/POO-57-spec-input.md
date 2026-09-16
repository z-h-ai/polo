# 实现 ProductSpace 最近文件入口

Stable slice key: `poo47-recent-files`  
Parent: POO-47（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

用户可在当前 ProductSpace 查看受信的助手附件、App 导入和 AI/App 导出最近文件，并用系统默认应用打开或在 Finder 中定位。

Business domain: trusted local file projection.

## Explicit dependencies

- 依赖 `POO-54` 完成 Acceptance、push 并集成。

## Scope

- 最近文件 projection、去重/排序/上限和来源元数据。
- canonical path 校验与受信目录 allowlist；拒绝失效路径和符号链接逃逸。
- Files 内置页面、搜索、来源/位置/时间/大小。
- 复用既有 `openFile` 与 `showInFolder`；renderer 只使用服务端回读的 canonical path。

## Non-goals

- 上传入口、任意磁盘扫描、文件管理器、跨 ProductSpace 自动搬运或 App 页面抓取。

## Interfaces

- Owns: `product-space-recent-files.v1`.
- Consumes: `runtime-projection.v1`, existing system open/reveal APIs.

## Planning bound

- Product files upper: 8.
- Core changed lines upper: 450.

## Acceptance criteria

1. 只合并三类受信来源；不存在上传入口或任意目录扫描。
2. personal/enterprise、workspace 和 runtime 文件不可交叉读取或写入。
3. 空格/Unicode 正常；不存在文件、跨 scope、allowlist 外路径和 symlink 逃逸拒绝。
4. 文件名调用默认应用，本机位置在 Finder 精确定位父目录。
5. Files 页面三视口 parity、交互和完整门禁通过。

## Re-pin gate

runtime foundation 集成后确认授权目录与 projection 扩展点，再接受最终 Plan。


