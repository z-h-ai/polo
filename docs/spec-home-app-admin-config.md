# 首页 App 管理后台配置

> 生成时间: 2026-06-25
> 访谈参与者: 铭龙, Claude
> 任务: POL-51

## 背景与目标

### 问题/需求背景

Polo AI 已有 Tab Browser（标签浏览器）功能，用户可以在其中管理自己的 App 列表。现需新增「组织级 App 管理」能力——Admin 可以在后台统一配置 App 并按用户组下发，普通用户也保留自行配置个人 App 的能力。两套列表在首页分区展示。

### 项目目标

1. Admin 能在 polo-admin 后台管理 App（CRUD + 排序 + 按用户组分配）
2. 用户端登录/启动时自动同步组织 App 列表
3. 首页分区展示「组织推荐」和「我的应用」

### 成功标准

- [ ] Admin 可创建、编辑、删除、排序 App，并分配给指定用户组
- [ ] 用户登录 admin 后，首页「组织推荐」区域展示所属组的 App
- [ ] 用户可独立管理「我的应用」区域，不受 Admin 配置影响
- [ ] App 同步使用独立版本号，登录和启动时触发

---

## 功能性需求

### FR-001: Admin App CRUD

- **描述**: Admin 在 polo-admin 后台创建、查看、编辑、删除 App
- **验收标准**:
  - [ ] 可创建 App，字段包含 name, url, icon(URL), description
  - [ ] 可编辑已有 App 的所有字段
  - [ ] 可删除 App，删除后用户端下次同步时移除
  - [ ] App 列表展示所有已创建的 App
- **优先级**: P0
- **依赖**: polo-admin 服务端

### FR-002: Admin App 排序

- **描述**: Admin 可调整 App 的显示顺序
- **验收标准**:
  - [ ] 支持拖拽或手动调整 App 的排序
  - [ ] 排序变更同步到用户端
- **优先级**: P0
- **依赖**: FR-001

### FR-003: Admin App 按用户组分配

- **描述**: Admin 将 App 分配给指定的用户组（group），不同组可看到不同的 App 列表
- **验收标准**:
  - [ ] 可为每个 App 选择可见的用户组
  - [ ] 未分配任何组的 App 默认对所有用户可见（或不可见，待确认）
  - [ ] 用户只能看到自己所属组被分配的 App
- **优先级**: P0
- **依赖**: FR-001, AdminUser.groupIds

### FR-004: 用户端 Admin App 同步

- **描述**: 用户端在登录和应用启动时，从 admin server 拉取当前用户可见的 App 列表，直接覆盖本地缓存
- **验收标准**:
  - [ ] 登录 admin 时触发 App 同步
  - [ ] 应用启动时（已登录状态）触发 App 同步
  - [ ] 使用独立的 appConfigVersion 做版本比对，无变化时跳过同步
  - [ ] 同步结果直接覆盖本地 admin app 列表
- **优先级**: P0
- **依赖**: FR-001, FR-003

### FR-005: 首页分区展示

- **描述**: 首页 Tab Browser 分两个区域展示 App：「组织推荐」（admin 同步的）和「我的应用」（用户本地配置的）
- **验收标准**:
  - [ ] 「组织推荐」区域展示从 admin 同步的 App，用户不可编辑/删除
  - [ ] 「我的应用」区域展示用户自行配置的 App，可自由增删改排序
  - [ ] 两个区域视觉上有清晰分隔
  - [ ] 未登录 admin 的用户不显示「组织推荐」区域
- **优先级**: P0
- **依赖**: FR-004

### FR-006: 用户个人 App 管理

- **描述**: 用户在「我的应用」区域自行添加、编辑、删除、排序 App，数据存储在本地文件
- **验收标准**:
  - [ ] 复用现有 tabBrowser:saveApps / tabBrowser:getApps RPC
  - [ ] 个人 App 数据存储在 ~/.polo-ai/ 本地文件
  - [ ] 个人 App 与组织 App 互不影响
- **优先级**: P0
- **依赖**: 已有 Tab Browser 功能

---

## 非功能性需求

### 性能

- **同步响应时间**: GET /api/apps < 500ms
- **数据量**: 单个组织预期 App 数量 < 100

### 安全

- **认证**: 复用现有 admin token 机制（accessToken + refreshToken）
- **授权**: GET /api/apps 需要有效的 admin token；/api/admin/apps/* 需要 admin 角色权限
- **数据保护**: App 数据不含敏感信息，无需加密存储

---

## 技术方案

### 架构设计

```
┌─────────────────────────────────────────────┐
│  polo-admin server                          │
│  ┌──────────────────────────────────────┐   │
│  │ App 管理 API                         │   │
│  │ - GET  /api/apps (用户端拉取)        │   │
│  │ - CRUD /api/admin/apps (管理端)      │   │
│  └──────────────────────────────────────┘   │
└─────────────────┬───────────────────────────┘
                  │ HTTP (Bearer token)
┌─────────────────▼───────────────────────────┐
│  Polo AI 客户端 (Electron)                  │
│  ┌────────────────┐  ┌───────────────────┐  │
│  │ AdminClient    │  │ 本地文件存储       │  │
│  │ (同步 admin    │  │ (用户个人 App)    │  │
│  │  app 列表)     │  │                   │  │
│  └───────┬────────┘  └────────┬──────────┘  │
│          │                    │              │
│  ┌───────▼────────────────────▼──────────┐  │
│  │ 首页 Tab Browser                      │  │
│  │ ┌──────────────┐ ┌─────────────────┐  │  │
│  │ │ 组织推荐      │ │ 我的应用        │  │  │
│  │ │ (admin apps) │ │ (user apps)     │  │  │
│  │ └──────────────┘ └─────────────────┘  │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### 数据模型

#### App（Admin 端管理）

```typescript
interface AdminApp {
  id: string           // 唯一标识，UUID
  name: string         // 应用名称
  url: string          // 应用 URL
  icon: string         // 图标 URL
  description: string  // 应用描述
  sortOrder: number    // 排序序号
  groupIds: string[]   // 可见的用户组 ID 列表（空数组 = 所有用户可见）
  createdAt: string    // 创建时间 ISO 8601
  updatedAt: string    // 更新时间 ISO 8601
}
```

#### App（用户端同步后的本地存储）

```typescript
interface SyncedAdminApp {
  id: string
  name: string
  url: string
  icon: string
  description: string
  sortOrder: number
  managedBy: 'admin'   // 标记来源
}
```

#### App（用户个人 App，复用现有结构）

```typescript
interface UserApp {
  id: string
  name: string
  url: string
  icon: string
  description: string
  sortOrder: number
}
```

#### 同步版本

```typescript
interface AppSyncState {
  appConfigVersion: string   // 当前已同步的版本号
  syncedAt: number           // 最后同步时间戳
  apps: SyncedAdminApp[]     // 同步的 App 列表
}
```

### API 设计

#### 1. 用户端拉取可见 App 列表

- **Method**: GET
- **Path**: `/api/apps`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Query**: `?version=<appConfigVersion>` （可选，用于版本比对）
- **响应格式**:
  ```json
  {
    "appConfigVersion": "v2",
    "apps": [
      {
        "id": "uuid",
        "name": "内部知识库",
        "url": "https://wiki.example.com",
        "icon": "https://wiki.example.com/favicon.ico",
        "description": "公司内部知识库",
        "sortOrder": 1
      }
    ]
  }
  ```
- **说明**: 服务端根据用户 groupIds 过滤返回可见的 App；若请求的 version 与服务端一致，返回 `304 Not Modified`

#### 2. Admin 获取全部 App

- **Method**: GET
- **Path**: `/api/admin/apps`
- **Headers**: `Authorization: Bearer <accessToken>`（需 admin 权限）
- **响应格式**:
  ```json
  {
    "apps": [
      {
        "id": "uuid",
        "name": "内部知识库",
        "url": "https://wiki.example.com",
        "icon": "https://wiki.example.com/favicon.ico",
        "description": "公司内部知识库",
        "sortOrder": 1,
        "groupIds": ["group-dev", "group-pm"],
        "createdAt": "2026-06-25T10:00:00Z",
        "updatedAt": "2026-06-25T10:00:00Z"
      }
    ]
  }
  ```

#### 3. Admin 创建 App

- **Method**: POST
- **Path**: `/api/admin/apps`
- **请求参数**:
  ```json
  {
    "name": "内部知识库",
    "url": "https://wiki.example.com",
    "icon": "https://wiki.example.com/favicon.ico",
    "description": "公司内部知识库",
    "groupIds": ["group-dev"]
  }
  ```
- **响应格式**: 返回创建的完整 App 对象（含 id, sortOrder, createdAt, updatedAt）

#### 4. Admin 更新 App

- **Method**: PUT
- **Path**: `/api/admin/apps/:id`
- **请求参数**: 同创建，所有字段可选（部分更新）
- **响应格式**: 返回更新后的完整 App 对象

#### 5. Admin 删除 App

- **Method**: DELETE
- **Path**: `/api/admin/apps/:id`
- **响应格式**: `{ "success": true }`

#### 6. Admin 调整排序

- **Method**: PUT
- **Path**: `/api/admin/apps/order`
- **请求参数**:
  ```json
  {
    "orderedIds": ["uuid-1", "uuid-3", "uuid-2"]
  }
  ```
- **响应格式**: `{ "success": true }`

#### 7. Admin 分配用户组

- **Method**: PUT
- **Path**: `/api/admin/apps/:id/groups`
- **请求参数**:
  ```json
  {
    "groupIds": ["group-dev", "group-pm"]
  }
  ```
- **响应格式**: 返回更新后的完整 App 对象

---

## 边界条件与异常处理

| 场景 | 处理策略 |
|------|----------|
| 用户未登录 admin | 不显示「组织推荐」区域，只显示「我的应用」 |
| admin token 过期 | 复用现有 token 刷新机制，刷新后重试同步 |
| 同步网络失败 | 使用本地缓存的上一次同步结果，静默失败 |
| admin 删除了用户正在使用的 App | 下次同步时从列表移除，无额外提示 |
| appConfigVersion 不变 | 返回 304，跳过数据传输 |
| groupIds 为空数组 | 该 App 对组织内所有用户可见 |

---

## 权衡与决策记录

| 决策点 | 选择 | 原因 | 替代方案 |
|--------|------|------|----------|
| Admin App vs 用户 App 关系 | 完全独立 | 简化逻辑，避免合并冲突 | Admin 锁定+用户追加、Admin 默认+用户覆盖 |
| 展示方式 | 分区展示 | 清晰区分来源，用户感知明确 | 合并展示带标记、Tab 切换 |
| 分配粒度 | 按用户组 | AdminUser 已有 groupIds，复用现有结构 | 组织统一、按单个用户分配 |
| 同步版本号 | 独立 appConfigVersion | 与 LLM Connections 解耦，互不影响 | 共用 configVersion、每次全量拉取 |
| 变更策略 | 直接覆盖 | 简单可靠，admin 拥有组织 App 的绝对控制权 | 覆盖+提示、智能合并 |
| Icon 方案 | 纯 URL | 简单，无需文件上传基础设施 | 上传+URL、内置图标库 |
| 用户个人 App 存储 | 本地文件 | 复用现有 tabBrowser 机制，无服务端依赖 | 同步到服务端、本地+可选同步 |
| 同步时机 | 登录 + 应用启动 | 覆盖主要使用入口，不需要定时轮询 | 登录+定时、实时推送 |

---

## 待确认问题

- [ ] 未分配任何 groupIds 的 App，是对所有用户可见还是对所有用户不可见？（本 spec 假设为所有用户可见）
- [ ] polo-admin 是否已有用户组（group）管理功能？若无，需同步建设
- [ ] Admin 创建 App 时是否需要验证 URL 可达性？
- [ ] 是否需要支持 App 的「启用/禁用」状态（不删除但暂时不展示）？
