# product-closure-20261027 E2E nails

B 组实现(product-closure 2026-10-27)的四枚 e2e 钉子。真实 Electron + 生产模块;
窗口管理 / IPC / 登录态为夹具桩(见各文件头注释),其余全部为生产源码。

## 运行

```bash
bun apps/electron/e2e/product-closure-20261027/run.mjs
```

退出码 0 = 全部钉子通过且 console 零 error。证据(`runtime.json` + 截图 +
capture 回执)落在 `$PC_EVIDENCE_DIR`(默认 `/tmp/product-closure-20261027/evidence`)。

## 四枚钉子

| # | 验收 | 断言 |
|---|------|------|
| ① | U6 toolbar i18n | 初始 `?lang=zh-Hans` 经 query 传入;主进程语言切换经 `broadcastToolbarLanguage` 实时跟随(`窗口选项` → `Window options`);zh/en 两遍 console 无任何 i18next / react-i18next / missingKey 警告 |
| ② | U7 tab 名渲染期翻译 | 生产 `localizedTabTitle` 对历史持久化中文名(`title: 'Polo 助手'`)按 app id 覆盖;zh↔en 运行时切换即时翻转;第三方名不被改写 |
| ③ | U11 下载 toast | fixture 站点触发下载 → 会话绑定路径 `<build>/sessions/sess-a/downloads/` 落盘 → 生产 `useSidebarBrowserSync` 弹「已下载」toast 且带「打开所在文件夹」动作 |
| ④ | U12 登出销毁 | renderer 调 `electronAPI.browserPaneDestroyAll()` → main 侧 `destroyAllAndClearStorage` 恰好一次、实例清空(manager 的 clear 语义由单元测试覆盖) |

## 隔离边界

- 下载落盘、userData、evidence 全部在 `/tmp/product-closure-20261027` 内,不碰用户目录。
- `showInFolder`、主题、偏好等 electronAPI 为夹具桩;浏览器实例、toolbar 页、
  下载链路、销毁链路均为生产代码。
