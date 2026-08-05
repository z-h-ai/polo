# CLI 执行所有者消失后终止后台运行

独立的 CLI 执行运行时通过进程身份、独占租约和 heartbeat 持续确认 CLI 执行所有者仍然存在；所有者即使被 `SIGKILL` 强制终止，后台运行也要自行取消任务并退出，不能成为孤儿进程。Stale cleaner 只回收 owner 与 runtime 均不存在、租约失效且 heartbeat 超过安全宽限期的 ephemeral Thread，并先原子移入 trash；普通持久化 Thread 永不自动删除。额外的监督和租约复杂度用于换取并发安全与不误删历史。
