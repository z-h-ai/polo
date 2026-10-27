# e2e/version-consistency — POO-160

真实 Electron + 生产设置面，钉住「设置 → 关于 → 版本」与左上角 Polo AI 应用身份
（macOS 应用菜单 → About Polo AI，即 `app.getVersion()` / electron-builder 写入
Info.plist 的值）的版本一致性。

## 背景

POO-160：用户报告设置页「关于-版本」与左上角 Polo AI 版本不一致。根因是
`packages/shared/package.json` 不在 `scripts/release-version.ts` 的 `VERSION_FILES`
同步名单里，停在 0.10.0；设置页 About 读 `@polo-ai/shared/version` 的
`APP_VERSION`（= shared 的 package.json），而应用身份读 `apps/electron/package.json`。
修复：shared 进名单并 bump 到 0.22.0；同时 `auto-update.ts` 的
`updateInfo.currentVersion` 锚定 `app.getVersion()`，与 electron-updater 的更新
比较同源。

## Harness 边界

- 挂载的是生产 `GlobalSettingsSurface`（subpage="app" → 真实 `AppSettingsPage`，
  含 About 区），生产 i18n、生产 `useUpdateChecker`。
- `update:getInfo` 的回答来自**生产** `apps/electron/src/main/auto-update.ts`
  （`probe-update-info` handler 动态 import 后调用 `getUpdateInfo()`），非 stub 常量。
- 以 app **目录**模式启动（build 目录带 package.json，version 取自
  `apps/electron/package.json`），`app.getVersion()` 因此等于打包应用的身份版本；
  defaultApp 模式（直接跑 main.cjs）会拿到 Electron 运行时版本，不可用。
- 除 update 链路外的 electronAPI 是 canned fixture（见 `preload.ts`）。
- 本 harness 只钉**显示一致性**：`probe-check-updates` 接了真实 `checkForUpdates()`
  但主流程不触发它——更新可用性判定由 electron-updater 内部完成（比较基于
  `app.getVersion()`，依赖网络 feed），不属于本钉子的运行期断言范围。

## Checks（PASS 线：6/6）

| # | 断言 |
|---|---|
| V1 | IPC 链路返回的 `currentVersion` == `app.getVersion()` |
| V2 | About 行把该版本号渲染到页面（用户可见面） |
| V3 | shared bundle 内联的 `APP_VERSION` == `app.getVersion()`（packages/shared 与发布版本一致） |
| V4 | 页面上出现的所有 `X.Y.Z` 串都等于应用身份（无旧版本残影） |
| — | 凭据通道：截图后可见文本核对（identity.version_shown 在页面） |
| — | console 零 error |

## 运行

```bash
bun apps/electron/e2e/version-consistency/run.mjs
```

证据（`about-version.png` / `.capture.json` / `runtime.json`）落
`$POO160_EVIDENCE_DIR`（默认 `/tmp/poo160-version/evidence`）。

复现修复前 bug：stash 掉 `packages/shared/package.json` 与
`apps/electron/src/main/auto-update.ts` 的修复再跑——V1–V4 全 FAIL，
About 行显示 0.10.0 而 `app.getVersion()` 为 0.22.0。
