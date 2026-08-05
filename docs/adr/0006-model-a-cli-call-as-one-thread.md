# 一次 CLI 调用建模为一个公开 Thread

一次 `polo run` 或 `polo exec` 创建的主 session 及 branch、fork、`spawn_session` 派生 session 共同构成一个 CLI Thread，并以全局唯一 UUID `thread_id` 作为 JSONL、resume、list 和 delete 的唯一公开标识。持久化、stale 判断和删除都以 Thread 为边界，resume 默认进入主 session；这放弃了直接暴露现有人类可读 session slug，却避免派生记录失去所有者以及跨 scope ID 冲突。
