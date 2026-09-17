# Polo 客户端 UI v1 冻结记录

- 状态：已冻结
- 确认时间：2026-08-11T18:17:12Z
- 确认人：产品用户（本次对话明确确认“完成 1、2”）
- `artifactCommit`：`ef3528ef371b785a1932b8a65356a62ad463538e`
- 源码参考基线：`01f4447cf77612ca2c62d9c7155601a51bdb7b5b`
- 确认范围：Polo 客户端 PC-F01～PC-F11 整端 UI v1
- 评审入口：`design-demos/polo-client-g4-ui/index.html`

## 冻结验收

- 98 个客户端 `scene`：全部可达。
- 空白页：0。
- JavaScript 异常：0。
- 超过 15 个汉字的可见辅助说明：0。
- 1440×900、1024×768、390×844：无视口失败；390 使用窗口保护。
- 关键路径：首页、全部 Apps、圈子、助手 Tab、App 启动、文件、任务、登录与安全切换通过。
- 最终走查修复：目标企业访问失效后移出切换器；注销阻断单列企业 Owner、Creator Owner 与未结订单；离线/重连显示缓存和重新校验状态。
- `evidenceDigest`：`9989b4ded1a5161f9a3b09ca6108d7d4c1e6c7f2db140ae3952add2ed1bb5a81`

摘要载荷：

```json
{"artifactCommit":"ef3528ef371b785a1932b8a65356a62ad463538e","scenes":98,"blankPages":0,"jsExceptions":0,"longAuxiliary":0,"viewportFailures":0,"criticalPathFailures":0}
```

## 本版不包含

- 企业组织管理端、创作者工作台和平台运营端 UI。
- 正式 ProductSpace、Catalog、Runtime 与后端实现。
- Polo 助手内部组件重构；由 POO-44 复用真实助手代码完成。
- 手机端完整客户端体验；390×844 仅验证窗口保护。

冻结后如修改产品页面、状态语义或交互，必须生成新的 artifact commit 并重新确认。
