# Polo 管理的 CLI 产物按 Thread 隔离存储

CLI 私有存储使用 `<configuration-scope>/executions/<thread-id>/` 作为保留、恢复和清理边界，Thread metadata、owner metadata 与内部 `sessions/` 分离，并由可注入的完整 SessionStorage 服务解析所有路径。全部 Polo 管理的 session、附件、计划、数据和恢复 sidecar 位于当前用户私有的 CLI root；provider SDK 自有缓存可以留在 provider 目录，但不能进入 Electron workspace。相比 UI 隐藏或平铺 session，这增加了存储抽象成本，却从创建时建立 Electron 无法发现的物理边界。
