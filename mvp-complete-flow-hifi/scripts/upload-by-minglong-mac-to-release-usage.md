# upload-by-minglong-mac-to-release.sh 使用说明

把本机制作好的 Polo AI Electron 发布产物上传到 Zeabur 静态更新服务器，并自动做三道校验。

## 用法

```bash
# 默认从 ~/Downloads/polo-v<version> 上传
scripts/upload-by-minglong-mac-to-release.sh 0.15.2

# 自定义源目录
scripts/upload-by-minglong-mac-to-release.sh 0.15.2 --src /path/to/dist

# 查看帮助
scripts/upload-by-minglong-mac-to-release.sh --help
```

## 前置条件

### 1. SSH key 认证已安装（一次性）

本机 `~/.ssh/id_rsa.pub` 需要写入远端 `root@120.25.198.159:~/.ssh/authorized_keys`，使 `ssh root@120.25.198.159` 免密直接进入。

安装方法（在本机执行）：

```bash
# 假设你已经能通过密码 ssh 上去
ssh-copy-id -i ~/.ssh/id_rsa.pub root@120.25.198.159
# 或手动：
cat ~/.ssh/id_rsa.pub | ssh root@120.25.198.159 \
  "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

验证：

```bash
ssh -o BatchMode=yes root@120.25.198.159 'echo OK'
# 应直接输出 OK，不提示密码
```

### 2. 源目录结构

脚本上传源目录下**所有文件**（覆盖同名）到远端 `electron/releases/<version>/`。默认源目录是 `~/Downloads/polo-v<version>`，应包含：

```
~/Downloads/polo-v0.15.2/
├── Polo-AI-x64.AppImage     # Linux
├── Polo-AI-x64.dmg          # macOS
├── Polo-AI-x64.zip          # macOS (auto-update 用)
├── install-app.sh
├── latest-linux.yml
├── latest-mac.yml
└── release-contract.json
```

### 3. 本机工具

- `ssh` / `scp`（macOS 自带）
- `shasum -a 256` 或 `sha256sum`（macOS 自带 shasum）
- `curl`（macOS 自带）
- `codesign` / `spctl` / `xcrun stapler`（仅当存在 `.dmg` 时才用到，macOS 自带）

## 脚本流程

1. **预检** — 验证免密 ssh 可达，否则立即报错并提示安装 pubkey。
2. **创建远端目录** — `mkdir -p <PVC>/electron/releases/<version>`。
3. **上传** — `scp` 一次传源目录所有文件，覆盖同名。
4. **校验 1：SHA256** — 逐文件对比本地与远端 `sha256sum`，不一致即报错退出。
5. **校验 2：CDN HEAD** — 对 `https://updates.polo.z-h-ai.com/electron/latest/<file>` 发 HEAD，要求 7 个文件全部 HTTP 200。
6. **校验 3：DMG 内 .app 签名 + 公证**（仅当 `.dmg` 存在且有 `codesign`）：
   - `hdiutil` 挂载 DMG
   - `codesign --verify --strict --deep` 通过
   - `TeamIdentifier == ZH2RDLUUAB`
   - `spctl --assess --type execute` 输出 `source=Notarized Developer ID`
   - `xcrun stapler validate` 通过
   - 卸载 DMG
7. 全部通过输出 `==> Done. v<version> uploaded and verified.`

任何一步失败立即非零退出，已上传的文件不会回滚（但下次跑会覆盖重传）。

## 远端架构参考

- **主机**：`120.25.198.159`（阿里云 Ubuntu 24.04 + k3s 节点，**无 docker**，只有 `kubectl`/`crictl`/`ctr`）
- **PVC host 路径**：`/var/lib/rancher/k3s/storage/pvc-15a26fab-5a51-45d5-9610-bf74630e57ce_environment-6a7545fa5f062718bc7b62bb_releases-service-6a755c10e4a69d66638c75df/electron/releases/<version>/`
- **容器**：Pod `service-6a755c10e4a69d66638c75df-7fcbc87859-w9kkm`（namespace `environment-6a7545fa5f062718bc7b62bb`），把上述 PVC 挂载在 `/data`，所以容器内对应路径是 `/data/releases/electron/releases/<version>/`
- **CDN**：`https://updates.polo.z-h-ai.com/electron/latest/<file>`，由 Caddy 提供。二进制（dmg/zip/AppImage）走 `public, max-age=31536000, immutable`，清单（yml/json/sh）走 `no-cache`，便于客户端拿到最新版。

直接 scp 到 host PVC 路径是上传的最快方式，比 `kubectl cp` 走容器更稳，尤其对几百 MB 的二进制。

## 已验证版本

- **v0.15.2**：7 个文件全部上传，SHA256 一致，CDN 7×200，DMG 内 `Polo AI.app` 通过 `Developer ID Application: minglong ou (ZH2RDLUUAB)` 签名 + Notarized + stapled。

## 常见问题

**Q: 报 `Passwordless SSH to ... failed`**
A: 远端 `~/.ssh/authorized_keys` 没有你的 pubkey，按上文「前置条件 1」安装。

**Q: 报 `SHA mismatch: <file>`**
A: 上传过程中文件被改动或网络中断。重跑脚本即可覆盖重传。如果反复失败，检查本机源文件是否还在被 electron-builder 写入。

**Q: 报 `CDN HEAD <file> -> 404`**
A: Zeabur 静态服务可能没刷新。PVC 写入后通常立即可见，但如果 service 配置了缓存层，可能需要等几秒或在 Zeabur 控制台 redeploy `updates-static-v4`。

**Q: 报 `spctl: not 'Notarized Developer ID'`**
A: DMG 内的 `.app` 未通过公证。检查 electron-builder 配置是否启用了 notarize，以及 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 三个 secrets 是否正确。

**Q: 想跳过 DMG 签名校验**
A: 临时把 `EXPECTED_TEAM_ID` 改成空字符串，或在脚本里注释掉 DMG 校验块。但发布到生产环境前强烈建议保留。

**Q: 上传到非 `~/Downloads/polo-v<version>` 的目录**
A: 用 `--src` 指定，例如 `--src apps/electron/release/mac`。

## 相关文件

- 脚本：`scripts/upload-by-minglong-mac-to-release.sh`
- 项目记忆：`MEMORY.md` 中「Zeabur static-update host」段落
- 发布校验器（CI 内更严格的版本）：`apps/electron/scripts/validate-final-artifacts.sh`
- 发布工作流：`.github/workflows/electron-artifact-full.yml`
