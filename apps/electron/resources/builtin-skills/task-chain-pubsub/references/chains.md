# YAML 单依赖链

在工作区 `task-events/chains/` 写 YAML／JSON，服务初始化时读取，修改后需重启服务；没有热加载。

```yaml
chain: review-after-implement
steps:
  - {id: implement, session: "实际 Polo 上游 session ID"}
  - id: review
    session: "实际 Polo 审查 session ID"
    after: implement
    prompt: "确认上游成功后审查产出；若取消或失败，报告原因并停止。"
```

每条依赖使用单次订阅；step ID 只是文件内的引用别名，session 字段必须是 Polo session ID。同一条依赖投递确认后，重启不会重新挂起。新一轮链使用新的文件名／step ID，并准备没有旧终态的 pending 下游会话，不能复用仍为 closed 的中间步骤，否则历史完成可能越过新依赖；运行时会拒绝这类链。不要手改订阅持久化状态。

仅支持单个 after，不支持多上游 AND join。会话、权限范围、引用或环检测失败时整链不应用；检查服务日志后修复文件，不能声称已生效。删除或写坏文件会在下次初始化时解除其未消费监听。未提供 Polo 会话工具的外部 Agent 不能靠创建同名 YAML 获得运行时支持。
