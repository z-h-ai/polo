# CLI 执行始终独立于 Electron

`polo run` 和 `polo exec` 始终使用独立的 CLI 执行运行时，即使 Electron 已经运行，也不连接或复用 Electron 的运行时。这样会增加独立进程的启动和生命周期管理成本，但能从会话创建的第一刻建立清晰边界，确保 CLI 会话不会进入 Electron 的加载、索引、统计和通知链路。
