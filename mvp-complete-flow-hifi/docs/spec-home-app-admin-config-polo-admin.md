# 首页 App 管理 — polo-admin 服务端

> 生成时间: 2026-06-25
> 拆分自: spec-home-app-admin-config.md
> 任务: POL-51
> 归属: polo-admin（服务端 + 管理后台）

## 背景与目标

### 需求背景

Polo AI 客户端已有 Tab Browser 功能，用户可管理个人 App 列表。现需在 polo-admin 服务端新增「组织级 App 管理」能力，Admin 可统一配置 App 并按用户组下发给客户端用户。

### 项目目标

1. polo-admin 提供 App 管理的完整 CRUD API
2. 支持按用户组（group）分配不同的 App 列表
3. 提供用户端拉取接口，支持版本比对（appConfigVersion）避免无效同步

### 成功标准

- [ ] Admin 可在后台创建、编辑、删除、排序 App
- [ ] Admin 可将 App 分配给指定用户组
- [ ] 用户端可通过 `GET /api/apps` 拉取当前用户可见的 App 列表
- [ ] 支持 appConfigVersion 版本比对，无变化时返回 304

---

## 功能性需求

### FR-001: Admin App CRUD

- **描述**: Admin 在 polo-admin 后台创建、查看、编辑、删除 App
- **验收标准**:
  - [ ] 可创建 App，字段包含 name, url, icon(URL), description
  - [ ] 可编辑已有 App 的所有字段
  - [ ] 可删除 App
  - [ ] App 列表展示所有已创建的 App
  - [ ] 每次增删改操作后递增 appConfigVersion
- **优先级**: P0

### FR-002: Admin App 排序

- **描述**: Admin 可调整 App 的显示顺序
- **验收标准**:
  - [ ] 支持通过 API 批量更新排序（传入有序 ID 列表）
  - [ ] 排序变更触发 appConfigVersion 递增
- **优先级**: P0
- **依赖**: FR-001

### FR-003: Admin App 按用户组分配

- **描述**: Admin 将 App 分配给指定的用户组（group），不同组可看到不同的 App 列表
- **验收标准**:
  - [ ] 可为每个 App 设置可见的用户组 groupIds
  - [ ] groupIds 为空数组时，该 App 对所有用户可见
  - [ ] 分配变更触发 appConfigVersion 递增
- **优先级**: P0
- **依赖**: FR-001, 用户组管理功能

### FR-004: 用户端 App 拉取接口

- **描述**: 提供 `GET /api/apps` 接口，用户端凭 token 拉取当前用户可见的 App 列表
- **验收标准**:
  - [ ] 根据用户 groupIds 过滤返回可见的 App
  - [ ] 支持 `?version=` 查询参数，版本一致时返回 304 Not Modified
  - [ ] 响应包含 appConfigVersion 和 apps 数组
- **优先级**: P0
- **依赖**: FR-001, FR-003

---

## 数据模型

### AdminApp

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

### appConfigVersion

- 独立于 LLM Connections 的 configVersion
- 每次 App 增删改、排序变更、分组变更时递增
- 格式建议：递增整数或时间戳字符串

---

## API 设计

### 1. 用户端拉取可见 App 列表

- **Method**: GET
- **Path**: `/api/apps`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Query**: `?version=<appConfigVersion>`（可选）
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
- **说明**: 根据 token 中的用户 groupIds 过滤；version 一致时返回 304

### 2. Admin 获取全部 App

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

### 3. Admin 创建 App

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
- **响应格式**: 返回创建的完整 AdminApp 对象（含 id, sortOrder, createdAt, updatedAt）

### 4. Admin 更新 App

- **Method**: PUT
- **Path**: `/api/admin/apps/:id`
- **请求参数**: 同创建，所有字段可选（部分更新）
- **响应格式**: 返回更新后的完整 AdminApp 对象

### 5. Admin 删除 App

- **Method**: DELETE
- **Path**: `/api/admin/apps/:id`
- **响应格式**: `{ "success": true }`

### 6. Admin 调整排序

- **Method**: PUT
- **Path**: `/api/admin/apps/order`
- **请求参数**:
  ```json
  {
    "orderedIds": ["uuid-1", "uuid-3", "uuid-2"]
  }
  ```
- **响应格式**: `{ "success": true }`

### 7. Admin 分配用户组

- **Method**: PUT
- **Path**: `/api/admin/apps/:id/groups`
- **请求参数**:
  ```json
  {
    "groupIds": ["group-dev", "group-pm"]
  }
  ```
- **响应格式**: 返回更新后的完整 AdminApp 对象

---

## 安全

- **认证**: 复用现有 admin token 机制（accessToken + refreshToken）
- **授权**:
  - `GET /api/apps` — 需要有效的 admin token（普通用户权限即可）
  - `/api/admin/apps/*` — 需要 admin 角色权限
- **数据保护**: App 数据不含敏感信息，无需加密

---

## 边界条件与异常处理

| 场景 | 处理策略 |
|------|----------|
| 未认证请求 | 返回 401 Unauthorized |
| 非 admin 角色访问 /api/admin/* | 返回 403 Forbidden |
| 删除不存在的 App | 返回 404 Not Found |
| 创建时缺少必填字段 | 返回 400 + 字段校验错误信息 |
| groupIds 引用不存在的组 | 允许保存（不做外键校验），客户端过滤时自然跳过 |
| appConfigVersion 一致 | GET /api/apps 返回 304 Not Modified |

---

## 待确认问题

- [ ] groupIds 为空数组时，是对所有用户可见还是不可见？（本 spec 假设为所有用户可见）
- [ ] polo-admin 是否已有用户组（group）管理功能？若无，需同步建设
- [ ] Admin 创建 App 时是否需要验证 URL 可达性？
- [ ] 是否需要支持 App 的「启用/禁用」状态？
