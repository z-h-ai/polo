父任务：POO-44

## 目标

实现助手发送前积分不足、生成中耗尽、部分输出保留和充值后由用户主动触发的人工恢复闭环。

## 前置依赖

- POL-103（ProductSpace 积分商品、订单、支付渠道与查询 API）。
- POO-48（助手会话、附件、Skills 与执行上下文的 ProductSpace 隔离）。
- POO-52（成员 Skill enablement 与版本化深链；按本轮串行集成顺序，完成后执行本卡）。

## 范围

- 发送前不足：不创建助手消息，保留可编辑草稿，禁用发送并给出角色允许的动作。
- 生成中耗尽：停止后续生成，保留已经返回的部分输出，只在该回答末尾给出一次提示和恢复动作。
- personal/Enterprise Owner 可“去充值”；Manager/Member 只能“通知 Owner”。
- 充值完成后提供“已完成，查询结果”；仅在用户点击时查询一次，未到账或仍不足时允许再次手动点击。
- 查询成功只解除输入阻断，不自动发送草稿、不自动续写、不自动创建运行或重试任务。

## 非目标

- 正常对话中的余额、积分、保护上限、实际消耗、模型、Token、供应商或结算展示。
- 支付商品、订单、渠道回调和账本实现。
- App Runtime 的平台级阻断。
- 助手组件、会话与 Skills 隔离的重新实现。

## 验收标准

1. 正常对话、正常完成、用户主动停止和普通结果不显示积分或结算信息。
2. 发送前不足保留可编辑草稿，不创建消息；生成中耗尽保留部分输出且不重复横幅。
3. 用户主动停止只显示“已停止生成”；正常完成后余额恰好为零不把当前回答标记为中断。
4. 充值完成后只在用户点击时单次查询；不轮询、不自动发送、不自动续写、不自动创建运行或重试。
5. Manager/Member 只能通知 Owner，不能通过深链、伪造角色或隐藏入口查看余额或进入充值写流程。
6. 查询未到账、处理中、失败或仍不足时保持可重试的人工动作和原草稿/部分输出。

## 视觉验收

- 启用 parity 视觉门禁，视口为 1440×900、1024×768、390×844。
- 按 `POO-41` UI v1 复用真实助手组件，并按 `POL-94` 客户端第二轮原型验收发送前不足、生成中耗尽、角色动作和充值后单次查询；只引用权威设计，不复制设计产物。

## 自动继续与暂停规则

客户端状态机、草稿持久化和查询请求实现由研发决定。只有角色动作、提示文案、单次查询语义或冻结助手交互需要改变时暂停裁决。

---

## 实现 Plan

状态：`awaiting-upstream-repin`  
生成日期：2026-09-08  
顺序与基线确认：已确认 `POO-47 → POO-44 → POO-48 → POO-52 → POO-49`，POO 基线为 `integration/pol68-g5-client`；本卡明确在 POO-52 完成后执行  
负责人确认：依赖顺序与基线已确认；需等 POO-52 集成后锁定最终助手、scope 与平台恢复契约

### 1. 输入、基线与执行闸门

- 本卡正文是助手发送前不足、生成中耗尽、部分输出与人工恢复的权威；本计划基于卡片 rev `5d69799643b80d3e09b0154d89c8f2cd22136f84b3dbcbf7f3abb7869b3bd248`。
- 已核验 `integration/pol68-g5-client@6cbdf573961776c4e69a9d990fd943d418a9b71d`。当前代码只有 provider/quota 文案启发式 `isQuotaExhaustedError()`、全局 `quota-exhausted` input banner 和 catch 后普通 error message；它不能区分平台 ProductSpace 积分、企业预算、用户主动停止或 provider 429，也不能满足部分输出末尾一次提示与手动恢复。
- 本轮显式串行顺序把 POO-52 设为本卡完成后执行的调度依赖；开工前 POO-43、47、44、48、52 必须全部进入 `integration/pol68-g5-client`。POO-49 从当时最新集成 SHA 创建干净分支，并重审 task rev/文件路径。
- POL-103 只提供服务端支付/积分事实。客户端只消费稳定错误码、当前 ProductSpace 角色、支付中心 URL、幂等通知命令与一次性恢复查询；不得通过 HTTP status/文案/余额自行推断不足。
- “通知 Owner”不是本地假按钮：同一限制事件跨设备幂等，只含成员、企业、发生时间和“Polo 助手”，不得含会话标题、Prompt、文件或回答。推荐由 POO-47 的平台阻断共享契约提供 server-owned 通知 command；若 re-pin 后仍无该能力，必须由 API owner补齐或明确裁决，不能在本卡伪造成功。

### 2. 文件清单与归属

| 分类 | 文件 | 计划用途 |
|---|---|---|
| existing | `packages/shared/src/agent/errors.ts`、`diagnostics.ts`、`agent/backend/{claude,pi}/event-adapter.ts` | 保留 provider 错误语义；只把服务端确认的平台拒绝映射为专用 typed code，不把通用 402/429 当 ProductSpace 积分不足 |
| existing | `packages/shared/src/protocol/{dto,types,channels,routing}.ts` | 定义 assistant billing interruption stage、restriction reason、eventId 与手动动作结果；不传 payer/余额/价格 |
| existing | `packages/server-core/src/handlers/rpc/sessions.ts`、`packages/server-core/src/sessions/SessionManager.ts` | 在创建/发送/流式事件边界传播稳定平台拒绝；发送前不创建 assistant turn，生成中保留已提交 delta并只发一个终止事实 |
| existing | `apps/electron/src/renderer/App.tsx` | 删除基于 message/429 的 ProductSpace quota 猜测；实现可回滚的 send transaction 与 scope-owned restriction projection |
| existing | `apps/electron/src/renderer/context/AppShellContext.tsx` | 将输入阻断、角色动作、查询/通知 command 以 typed context 交给真实 ChatPage |
| existing | `apps/electron/src/renderer/pages/ChatPage.tsx` | 区分发送前 inline block、普通 provider/account banner 与生成中回答末尾状态；保持草稿可编辑 |
| existing | `apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx`、`InputContainer.tsx` | send 被阻断时不清草稿/附件；禁用发送但仍可编辑草稿，credit-stopped 时按冻结语义控制附件/Skill |
| existing | `apps/electron/src/renderer/event-processor/types.ts`、`handlers/session.ts`、`processor.ts`、`useEventProcessor.ts` | typed insufficient event 与 stage-aware reducer；去重同一 restriction event，保留 partial assistant content |
| existing | `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx` | 在对应回答末尾渲染一次 credit stop action；禁止通用 Retry 自动重放/续写 |
| new-by-this-task | `apps/electron/src/renderer/components/app-shell/AssistantCreditRecoveryNotice.tsx` | 发送前/生成中共用文案与按角色动作，但由宿主决定布局 |
| new-by-this-task | `apps/electron/src/renderer/components/app-shell/RechargeRecoveryDialog.tsx` | “是否已完成充值？”及 processing/not-found/failed/still-insufficient/recovered 的显式单次查询状态机 |
| new-by-this-task | `apps/electron/src/renderer/components/app-shell/__tests__/assistant-credit-recovery.interaction.isolated.tsx` | 草稿、partial output、角色、幂等通知、单次查询、无自动恢复矩阵 |
| new-by-this-task | `packages/server-core/src/handlers/rpc/assistant-credit-boundary.isolated.ts` | 发送前/中途、重复事件、scope drift、正常完成/用户停止/普通 429 的负向契约 |
| existing | `packages/shared/src/i18n/locales/{de,en,es,hu,ja,pl,zh-Hans}.json` | 冻结提示/动作/查询状态与无障碍文案，保持 parity/sorted/coverage |
| upstream-expected | POO-47 最终平台 restriction、payment-center、notify-owner、manual recovery query API | App 与助手复用同一事实/动作层；re-pin 后必须解析为真实路径 |
| upstream-expected | POO-48 最终 assistant scope token/generation fence | restriction、草稿、partial output、query result 均绑定 immutable account+ProductSpace+workspace+session |
| upstream-expected | POO-44/52 集成后的真实 assistant shell、Skills route 与 context 形态 | 只在最终结构上接线，不恢复重复全局入口，不影响 enablement route |

### 3. 冻结技术决策

1. **稳定平台事实，不做字符串猜测**：平台至少返回 `insufficient_credit`、`enterprise_budget_exhausted` 等稳定 reason，以及不可由客户端伪造的 `restrictionEventId`、ProductSpace、阶段 `pre_send|mid_stream`。provider 429、API key billing、账号禁用和普通网络错误走原错误体系。
2. **发送事务**：输入组件在服务器确认 accepted 前不清除 draft/attachments。若 pre-send 被拒绝，不创建 assistant/error turn，不发送持久化 user message；草稿保持可编辑，发送按钮禁用并显示一次 inline recovery。若当前架构需要短暂 optimistic user bubble，拒绝时必须按 operationId 精确回滚且不影响并发的新草稿。
3. **中途耗尽**：已收到的 assistant delta 保持原顺序和内容；终止后将结构化 credit stop marker 附在该回答末尾一次，`isProcessing=false`，不追加第二个全局 banner/通用错误卡。正常 complete 后余额为 0 不回写为中断；用户主动 stop 只显示“已停止生成”。
4. **按角色动作**：personal owner / Enterprise Owner 为“去充值”；Manager/Member 为“通知 Owner”。角色来自当前 trusted ProductSpace projection，不能由 route/query/UI state覆盖。“通知 Owner”按 restrictionEventId 幂等，成功后显示“已通知 Owner/检查是否恢复”。
5. **充值与查询**：“去充值”只在系统浏览器打开服务端签发的当前 ProductSpace 支付中心 URL，不选商品、不下单、不传 payer。返回客户端不触发查询；每次点击“已完成，查询结果/再次查询”仅发送一次请求。无 timer、focus listener、interval、retry middleware 或后台 poll。
6. **恢复不重放**：查询确认 restored 只解除当前 scope/session input restriction；原 draft仍在，partial answer仍终止。用户必须再次点击发送或另发消息；系统不自动发送、续写、创建 run 或调用通用 Retry。
7. **并发与 scope**：动作捕获 `accountId+productSpaceId+workspaceId+sessionId+scopeGeneration+restrictionEventId`；await 后任一变化即丢弃结果。一个空间恢复不得解除另一个空间或另一个新 restriction event。

### 4. 实施顺序

1. **Re-pin 契约审计**：确认 POO-47 已落地的 restriction reason、payment-center、notify-owner、query API 和 POO-48 token；把所有 `upstream-expected` 换成真实路径。若缺 notify command，先由平台 owner 补齐最小幂等端点再开 UI。
2. **共享 typed event**：扩展协议 DTO 和 event processor type，明确定义 pre-send/mid-stream、eventId、role action、query outcome。为普通 provider 429、账号禁用、用户 stop 建负向 fixtures。
3. **服务端发送边界**：在 billable assistant run start/usage extension 拒绝处生成唯一 typed restriction；pre-send 在任何 assistant turn/usage 事实前返回，mid-stream 在停止后保留已提交 output。重复回调按 eventId收敛。
4. **输入提交事务**：调整 `FreeFormInput`→`ChatPage`→`App.tsx` submit contract，使 draft/attachments 只在 accepted 后清理。pre-send refusal 设置 scope-owned restriction，但不创建 error bubble；切换 session/space 时不串状态。
5. **中途 reducer/UI**：event processor 把 marker挂到当前 assistant turn，`ChatDisplay` 在回答末尾渲染 `AssistantCreditRecoveryNotice`，并对该类错误禁用 generic `onRetry`。
6. **角色动作**：Owner action 打开受信支付中心并显示确认 dialog；Manager/Member 调 notify command，按 eventId 幂等并进入已通知/检查状态。所有 action await 后复验 scope。
7. **显式查询状态机**：`idle → confirming → querying → processing|not_found|failed|still_insufficient|recovered`；只有按钮 event进入 `querying`，每次点击一个 in-flight request，失败可再次手动点击。
8. **回归 POO-52 与普通聊天**：验证 Skills enablement 路由/页面不受影响；无信用问题的正常对话、provider quota、用户停止、网络失败仍使用原语义且不出现平台积分。

### 5. 验证与完成证据

- 发送前：输入含文字+附件+Skill；服务端拒绝后无 assistant/error turn、无持久化 user message、draft/attachments 可编辑、发送禁用、只显示正确角色动作。
- 中途：先输出两段 delta 再 insufficient；两段内容保留，回答末尾只有一次提示；重复同 event、重连、重放 snapshot 不重复；generic Retry 不可用。
- 区分：用户主动停止、正常 complete 后余额恰为 0、provider 429/402、账号禁用、网络断开均不被标成 ProductSpace credit stop。
- 角色：personal/enterprise Owner 可打开正确支付中心；Manager/Member 无充值/预算写入口，只能幂等通知 Owner；payload canary 证明没有对话标题、Prompt、文件、回答、payer/余额。
- 查询：window focus、应用恢复、dialog reopen、时间推进均产生 0 请求；每次按钮点击恰好 1 请求；处理中/未查到/失败/仍不足可再点；恢复只解锁，不自动发送/续写/run/retry。
- 隔离：personal-A/enterprise-B、session-1/session-2、新旧 restrictionEventId、切换中迟到结果；只能解除精确 owner。
- 视觉：POO-41/POL-94 在 1440×900、1024×768、390×844 验收发送前、生成中、Owner、Member、四类查询失败和 recovered；窄窗遵守冻结保护语义。
- 门禁：targeted tests 后运行 `bun run typecheck:all`、`bun run lint`、i18n parity/sorted/coverage、`bun run test`、`bun run electron:build`。
- 完成证据分别记录 baseline/task rev、API contract、tests、视觉、commit/push/远端相等、集成；POO-52 与 POO-49 的集成先后也要有 ancestor 证明。

### 6. 风险、回滚与非范围

- **分类风险**：当前 `isQuotaExhaustedError()` 把 429/文案都判 quota。例如第三方模型 rate limit 会错误显示“去充值”。推荐只接受平台 typed code，并保留 provider 错误原路径。
- **草稿风险**：当前 sender 在 backend ack 前就创建 optimistic user message。若只加 banner不改事务，会同时留下已发送气泡和可编辑草稿。推荐以 operationId 两阶段提交或精确回滚，测试并发编辑。
- **重复动作风险**：中途 typed error、session snapshot和 reconnect 可能重复到达。以 restrictionEventId 去重，而不是按文案或最后一条消息比较。
- **通知能力风险**：若服务端没有幂等 notify-owner，按钮不能显示“已通知”。推荐把最小通知 command 放在 POO-47 共享平台边界；若 owner不同，创建明确上游任务并暂停，不做本地 toast 冒充送达。
- 回滚先关闭新 UI/reducer，再回滚 typed protocol；保留 server fail-closed 和已产生的通知/账本事实，不做反向删除。
- 非范围：支付订单/回调/账本、App Runtime 阻断、助手 scope重做、Skill enablement、余额/Token/模型/供应商展示。

### 7. 被否决方案与自检

- 否决继续正则匹配 `quota|429|insufficient`：不可区分平台与 provider。
- 否决充值后自动轮询或 window-focus 查询：违反显式一次查询。
- 否决恢复后自动调用 send/retry/continue：会产生用户未授权的新费用与输出。
- 否决把 mid-stream 错误渲染成独立通用 error card：会丢失“属于该回答末尾”的语义并可能出现 Retry。
- 否决 Manager/Member 隐藏按钮但保留可调用充值 deep link：权限必须在服务端和客户端双重 fail closed。
- 自检问题：拒绝发生前后分别产生了哪些持久化事实？partial output 的最终 marker如何去重？每次 query 的触发源能否证明只有 click？notify 是否真实送达且不泄密？恢复是否绝无自动副作用？任一无法自动证明，计划不可接受。

### 8. Re-pin 清单

- [ ] POO-43、47、44、48、52 按本轮顺序完成 Acceptance、commit/push 并集成。
- [ ] POO-49 从最新 `integration/pol68-g5-client@sha` 建干净 worktree。
- [ ] POO-47 restriction/payment/notify/query 与 POO-48 scope API 全部解析为实际 `existing` 路径。
- [ ] notify-owner 若缺失，已有明确 owner、端点、幂等键和隐私字段裁决。
- [ ] 普通 provider 错误、用户停止和平台 credit 的分类表已锁定。
- [ ] task rev、文件清单、验证矩阵获负责人接受，状态才可改为 `accepted`。

## 2026-09-09 Scope 拆分与执行入口

状态：`coordination-only`。本卡保留原始 Intent、Spec、条件 Plan 与历史证据，但不再拥有产品代码 commit、实现 worktree或 Ultra 执行。

### 子任务与显式依赖

- POO-65：实现助手发送前积分阻断与人工恢复；依赖 POO-64 完成 Acceptance、push 并集成，并消费已集成的 POO-58 平台恢复与 POO-62 助手 scope 契约。
- POO-66：实现助手生成中积分耗尽与人工恢复；依赖 POO-65 完成 Acceptance、push 并集成。

### 协调完成条件

- POO-65、POO-66 均完成 Acceptance、commit/push、远端相等和集成证明后，本协调卡才可完成。
- POO-65 唯一拥有助手 typed restriction、真实幂等 notify-owner、payment-center 与 click-only recovery query 接线；POO-66 复用该契约，不建立第二套恢复 UI。
- 两张子卡均不得自动发送、续写、创建 Run 或重试。
