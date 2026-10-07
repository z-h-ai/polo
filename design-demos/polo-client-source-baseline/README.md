# Polo 助手原型源码与生成

产品需求、当前实现边界与评审范围只维护在 [客户端 Spec](../../docs/client-journey-review/spec.md)（重点见 §13.11）；本文件仅说明源码和生成方式。历史 README 已归档，位置见 Spec §12。

统一评审入口：[review.html](../../docs/mvp-complete-flow-hifi/review.html)。本目录维护助手表面，登录、首页、App 容器与跨端交接由 MVP 表面维护。

- `src/mvp/scenes.mjs`：助手场景、产品动作与旧 ID 兼容映射；统一 manifest 从这里导出。
- `src/mvp/Assistant.jsx`：原型组件。真实助手开发边界以 Spec 及 `apps/electron/src/renderer/` 为准。
- `prototype.html`：生成产物，禁止直接手改。
- [SOURCE-EVIDENCE.md](SOURCE-EVIDENCE.md)、[SCENE-TRACEABILITY.md](SCENE-TRACEABILITY.md)：固定版本的来源证据，按其记录版本解释。

在仓库根目录生成和校验：

```sh
python3 docs/mvp-complete-flow-hifi/tools/build_review.py
python3 docs/mvp-complete-flow-hifi/tools/validate_unified.py
```

交互变更按影响运行 `check_unified.py` 等现有检查；证据和质量报告按 Spec §12 维护。单独离线打开使用 `prototype.html?scene=A-personal-new`；嵌入评审由经来源窗口校验的消息通道控制。原辅助组件参考 `?reference=1` 不加入当前 MVP 评审地图。
