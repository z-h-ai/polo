# POO-70 master-r9 整理与原型同步记录

日期：2026-09-17

> 历史记录：本页保留 master-r9 当时的判断。第 20、35 行所述多圈冲突后来核实为用户已在 2026-09-16 裁决；当前以 master-r10 / D-PC-09 为准。历史交接事件 `evt_3750ff41cd984b6e9dbc7bec817310b7` 已过时，不能继续作为待决依据。

## 基线

- 本工作树整理基线：`6ba964f4df0ced8de0a4d7f0264246201deffdea`。
- POL-68 文档基线：`POL-68/refactor/comm-defs@c43754bab5700f20998eef971c0ff27f36eba743`。
- POL-94 第二轮基线：`POL-94/feat/product-space-credit-recharge@9ae3e7308317fe2dce5b5fb714bd0955c7054335`。
- 原型修订前 manifest：`prototype-manifest-before-master-r9.json`，revision `poo70-dpc07-v2-2`。
- 主说明修订前快照：`poo70-spec-before-master-r9.md`。

## 本轮产品说明变化

- 选定 `docs/client-journey-review/spec.md` 为唯一《Polo 客户端产品与用户流程说明》；其他模块文档、旧画布和高保真均标成历史或派生材料。
- 补齐 M01—M11 功能地图、角色/前置、自然入口、页面动作、成功/拒绝/空态/失败/取消/过期/恢复、跨端交接、数据与付款责任。
- 写入 D-PC-08：圈子权益只聚合到“我的空间”；圈子不是空间；企业不继承个人圈子、不订阅圈子；当前不建公开市场；私域不等于仅邀请。
- 按 POL-94 第二轮规则校正手动续费、积分阻断和 Browser 返回后的用户主动单次查询。
- 引用 POL-112 r11 的 ID-C01—10、D-ID-09—18；不在客户端重写共享身份规则。
- 当时误将 POL-68 / POL-94 对同一作品多圈归属列为冲突并交 POL-116；该判断已被 D-PC-09 替代，保留此行仅用于追溯。

## 本轮原型变化

- revision：`poo70-master-r9-v2-3`；91 个场景、1364 条 transitions、49 条 confirmations、3 条故事。
- 新增 `P-M02-CONFIRM-PERSONAL`：我的空间有活动时切企业，取消留在个人空间，确认后才切换。
- 修正 `P-M03-ALL-APPS`、`P-M03-HOME-ENT`、`P-M03-HOME-EMPTY-DIR`、`P-M07-EMPTY` 的圈子/企业目录和私域入口表达。
- 从企业上下文移除个人圈子通知；确认页背景使用对应空间的数据，不混用企业/个人目录。
- 状态保持“修改待复看”；没有启动产品编码、发布或真实产品验收。

## 交接与读回

- POO-70 正文最终读回 rev：`31d845c105702c93b1ee5ba20bdec427e44c80de753009e4ae256b3fb6fa1a83`。
- POO-71 正文最终读回 rev：`c8affcaee53b9e344bdebe09813403c7180af5ff5f7ccbebc45fcc99434e6d33`；状态 `done`。
- POO-71 AI 状态：`active=false`，最近 run `11293b27` 为 `completed`；它在本修订前完成，未消费 master-r9。
- POL-116 历史交接事件：`evt_3750ff41cd984b6e9dbc7bec817310b7`，曾 live posted；其“仍待裁决”前提已被后续核验推翻，当前不得继续引用为产品状态。

## 验证

- `validate_prototype.py`：v2 high_fidelity、91 scenes、offline and source-bound，通过并与前版比较。
- `smoke_review.py`：1364/1364 transitions，索引、标注、Back/Reset、三故事、双视口、hash 与检查器通过。
- `smoke_dpc07.py`：D-PC-07/08 深链、锚点、故事和新增确认页通过。
- `audit_viewports.py`：91 场景 × 2 视口，零横向溢出/越界；27 + 10 张代表截图。
