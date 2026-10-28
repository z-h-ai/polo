# poo161-canvas-recovery E2E nail

POO-161 画布白屏修复(d3b5e8f4)的真机钉子。真实 Electron + 生产数据管线
(SessionManager / PiEventAdapter / handleGenerateApp / shared jsonl 读写)+
生产渲染组件(GenUiAppCard inline 入口、CanvasPaneCard 侧栏与独立窗口载体);
窗口管理 / IPC / 登录态为夹具桩。两次 Electron 进程均以 **cwd=/** 运行——
Finder 启动条件,即触发本 bug 的用户环境。

## 运行

```bash
bun apps/electron/e2e/poo161-canvas-recovery/run.mjs
```

退出码 0 = 全部断言通过。证据(`runtime-create.json` / `runtime-recover.json` +
截图)落在 `$POO161_EVIDENCE_DIR`(默认 `/tmp/poo161-canvas-recovery/evidence`)。

## 断言链

| # | 阶段 | 断言 |
|---|------|------|
| ① | create | cwd=/ 下真实 generate_app 产出 bundle;经真实 PiEventAdapter → SessionManager 持久化后,session.jsonl 的 marker path 保持绝对(`{{SESSION_PATH}}/data/genui-apps/`),**无** `.` 损坏形态(写端修复) |
| ② | create | 把持久化结果手工改写为旧 bug 损坏形态(`path=".{{SESSION_PATH}}…`)后,生产读路径(readSessionMessages 与 getSession 两个入口)恢复出绝对路径(读端修复);真实 <webview> guest 在 inline 卡片、侧栏 CanvasPaneCard、独立窗口三个入口都 dom-ready 且非主帧零失败、guest 正文渲染出 bundle 文本 |
| ③ | recover | **重启进程**(新 Electron,cwd=/)重新从磁盘读取损坏 session.jsonl → 生产读路径恢复 → CanvasPaneCard 渲染历史会话画布,guest 正文校验通过(重启恢复) |

## 隔离边界

- workspace/session/config/evidence 全部在 `/tmp/poo161-canvas-recovery` 内,
  `POLO_AI_CONFIG_DIR` 指向构建目录内 config,不碰用户目录与真实会话。
- 账号登录与云端 AI provider 调用在 harness 范围之外(登录态为夹具桩);被测
  层是 POO-161 修复实际改动的数据完整性 + webview 加载层。真实 AI 生成链路的
  事件形状已由 PiEventAdapter(生产适配器)与 handleGenerateApp(生产 handler)
  代表;裸数组疑诊路径的排除见 c894971a→d3b5e8f4 的评审考据(POO-161 报告附录 B)。
