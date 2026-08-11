# 首页 App 管理 — polo-工作台客户端

> 生成时间: 2026-06-25
> 原始汇总规格已拆分并清理；本文件是客户端范围的保留版本。
> 任务: POL-51
> 归属: polo-工作台（Electron 客户端）

## 背景与目标

### 需求背景

polo-admin 服务端将提供组织级 App 管理 API（见 spec-home-app-admin-config-polo-admin.md）。客户端需要：
1. 在登录和启动时同步组织 App 列表
2. 首页 Tab Browser 分区展示「组织推荐」和「我的应用」
3. 保留用户自行管理个人 App 的能力

### 项目目标

1. 客户端 AdminClient 扩展 App 同步能力
2. 首页 Tab Browser 新增「组织推荐」分区
3. 用户个人 App 管理不受影响

### 成功标准

- [ ] 登录/启动时自动同步组织 App 列表
- [ ] 首页分区展示「组织推荐」和「我的应用」
- [ ] 组织 App 用户不可编辑/删除，个人 App 自由管理
- [ ] 未登录 admin 时不显示「组织推荐」区域

---

## 功能性需求

### FR-001: Admin App 同步

- **描述**: 用户端在登录和应用启动时，从 admin server 拉取当前用户可见的 App 列表，直接覆盖本地缓存
- **验收标准**:
  - [ ] 登录 admin 成功后触发 App 同步
  - [ ] 应用启动时（已登录状态）触发 App 同步
  - [ ] 使用独立的 appConfigVersion 做版本比对，无变化时跳过
  - [ ] 同步结果直接覆盖本地 admin app 缓存
  - [ ] 登出 admin 时清除本地 admin app 缓存
- **优先级**: P0
- **依赖**: polo-admin `GET /api/apps` 接口

### FR-002: 首页分区展示

- **描述**: 首页 Tab Browser 分两个区域展示 App
- **验收标准**:
  - [ ] 「组织推荐」区域展示从 admin 同步的 App，用户不可编辑/删除
  - [ ] 「我的应用」区域展示用户自行配置的 App，可自由增删改排序
  - [ ] 两个区域视觉上有清晰分隔（标题区分）
  - [ ] 未登录 admin 的用户不显示「组织推荐」区域
  - [ ] admin app 列表为空时不显示「组织推荐」区域
- **优先级**: P0
- **依赖**: FR-001

### FR-003: 用户个人 App 管理

- **描述**: 用户在「我的应用」区域自行管理 App，数据存储在本地文件
- **验收标准**:
  - [ ] 复用现有 `tabBrowser:getApps` / `tabBrowser:saveApps` RPC
  - [ ] 个人 App 数据存储在 `~/.polo-ai/` 本地文件
  - [ ] 个人 App 与组织 App 互不影响
- **优先级**: P0
- **依赖**: 已有 Tab Browser 功能（无新开发）

---

## 技术方案

### 架构变更

```
┌─────────────────────────────────────────────┐
│  Polo AI 客户端 (Electron)                  │
│                                             │
│  ┌────────────────────────────────────────┐  │
│  │ AdminClient (packages/shared)          │  │
│  │ + syncApps()     ← 新增              │  │
│  │ + getAdminApps() ← 新增              │  │
│  └───────────┬────────────────────────────┘  │
│              │                               │
│  ┌───────────▼────────────────────────────┐  │
│  │ RPC Handlers (packages/server-core)    │  │
│  │ + admin:syncApps  ← 新增 RPC channel │  │
│  └───────────┬────────────────────────────┘  │
│              │                               │
│  ┌───────────▼────────────────────────────┐  │
│  │ 本地存储                                │  │
│  │ ~/.polo-ai/admin-apps.json  ← 新增    │  │
│  │ ~/.polo-ai/tab-browser-apps.json (现有) │  │
│  └───────────┬────────────────────────────┘  │
│              │                               │
│  ┌───────────▼────────────────────────────┐  │
│  │ 首页 Tab Browser (apps/electron)       │  │
│  │ ┌──────────────┐  ┌─────────────────┐  │  │
│  │ │ 组织推荐      │  │ 我的应用        │  │  │
│  │ │ (只读)       │  │ (可编辑)        │  │  │
│  │ └──────────────┘  └─────────────────┘  │  │
│  └────────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### 涉及模块

| 模块 | 文件 | 变更 |
|------|------|------|
| **AdminClient** | `packages/shared/src/admin/client.ts` | 新增 `syncApps()` 方法 |
| **Admin Types** | `packages/shared/src/admin/types.ts` | 新增 `SyncedAdminApp`, `AppSyncState` 类型 |
| **RPC Channels** | `packages/shared/src/protocol/channels.ts` | 新增 `admin.SYNC_APPS` channel |
| **RPC Handlers** | `packages/server-core/src/handlers/rpc/admin.ts` | 新增 syncApps handler，在 login/validate 流程中调用 |
| **Tab Browser UI** | `apps/electron/src/renderer/` | Tab Browser 页面增加分区展示逻辑 |

### 本地数据模型

```typescript
// 新增：packages/shared/src/admin/types.ts

interface SyncedAdminApp {
  id: string
  name: string
  url: string
  icon: string
  description: string
  sortOrder: number
  managedBy: 'admin'
}

interface AppSyncState {
  appConfigVersion: string
  syncedAt: number
  apps: SyncedAdminApp[]
}
```

### 存储位置

- **组织 App 缓存**: `~/.polo-ai/admin-apps.json`（AppSyncState 结构）
- **个人 App**: 现有 tab-browser 存储位置不变

### 同步流程

```
1. 登录成功 / 应用启动（已登录）
   ↓
2. 读取本地 admin-apps.json 中的 appConfigVersion
   ↓
3. GET /api/apps?version={appConfigVersion}
   ↓
4a. 304 → 跳过，使用本地缓存
4b. 200 → 覆盖写入 admin-apps.json
   ↓
5. 通知 Tab Browser UI 刷新
```

### RPC Channel 定义

```typescript
// packages/shared/src/protocol/channels.ts
admin: {
  // 现有...
  SYNC_APPS: 'admin:syncApps',       // 触发 App 同步
  GET_ADMIN_APPS: 'admin:getAdminApps', // 获取本地缓存的 admin app 列表
}
```

---

## 边界条件与异常处理

| 场景 | 处理策略 |
|------|----------|
| 用户未登录 admin | 不显示「组织推荐」区域，只显示「我的应用」|
| admin token 过期 | 复用现有 token 刷新机制，刷新后重试同步 |
| 同步网络失败 | 使用本地缓存（admin-apps.json），静默失败 |
| 首次登录无本地缓存 | version 参数不传，全量拉取 |
| admin 登出 | 删除 admin-apps.json，UI 隐藏「组织推荐」区域 |
| admin-apps.json 损坏 | 忽略缓存，全量重新拉取 |

---

## 与 polo-admin 的接口依赖

本 spec 依赖 polo-admin 提供以下接口（详见 spec-home-app-admin-config-polo-admin.md）：

| 接口 | 用途 |
|------|------|
| `GET /api/apps?version=` | 拉取当前用户可见的 App 列表 |

仅依赖这一个接口，其余管理端 API 与客户端无关。
