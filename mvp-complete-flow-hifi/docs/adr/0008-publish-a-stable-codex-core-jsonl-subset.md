# 发布稳定的 Codex 核心 JSONL 子集

`polo exec --json` 对外发布由 `thread.started`、turn、item、error 及其成功和失败事件组成的稳定核心协议，并用当前 Codex CLI 样例回归；它不透传 Polo RPC 事件，也不承诺跟随每个 Codex 版本的全部字段。协议启动前错误走 stderr，启动后失败以 JSONL 结束，stdout 永远无普通文本或 ANSI；`-o` 交付成功后才能完成 turn。这个边界减少内部事件与第三方版本变化的耦合，同时让核心 Codex 消费者复用。
