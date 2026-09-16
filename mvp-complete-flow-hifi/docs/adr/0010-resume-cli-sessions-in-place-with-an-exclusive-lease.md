# CLI 会话原位恢复并使用独占租约

`polo exec resume` 默认使用 Thread 原配置工作区和执行目录，继续写入原 Thread 的主 session，不创建隐式副本，并在执行期间持有 Thread 级独占租约；并发恢复第二个命令立即失败。`resume --last` 只在相同配置 scope 与规范化执行目录内选择，不静默跨 workspace 猜测。这样保证 `thread_id` 始终指向一条明确历史，代价是同一 Thread 不能并行推进，显式分叉留给未来命令。
