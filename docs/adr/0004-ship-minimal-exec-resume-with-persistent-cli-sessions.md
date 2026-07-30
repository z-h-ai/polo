# 默认持久化 CLI Thread 必须同时可恢复和管理

`polo exec` 默认在成功、失败和中断后保留 CLI Thread，因此 P0 同时交付 `resume`、`resume --last`、`sessions` 和 `delete`，不接受“先保存、以后再恢复或管理”的中间状态。`--ephemeral` 始终清理临时 Thread，而 `resume --ephemeral` 从临时副本运行并保持原 Thread 不变；这增加了 P0 范围，却让默认持久化真正服务故障排查和继续执行，而不是制造不可见磁盘记录。
