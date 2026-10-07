import { ChevronDown, ChevronRight, ChevronUp, Circle, CircleCheck, FilePenLine, GitBranch, MessageCircleDashed, Copy, FileText, Check } from 'lucide-react'

// chat streaming / error / detail states. TurnCard.tsx (packages/ui) renders
// one assistant turn as a collapsible activity timeline + ResponseCard;
// MessageBubble (ChatDisplay.tsx) renders system error turns. Turn activities
// and their text (intent, thinking, response content, error payload) are named
// deterministic fixtures — the real values stream from IPC and cannot be
// derived from static source. Chrome (header + badges + composer) matches the
// conversation scene; ChatDisplay masked ScrollArea with CHAT_LAYOUT column
// (max-w-[840px], px-5 py-8, space-y-2.5). Root font-size 15px.

function Spinner({ size = 12 }) {
  return (
    <span
      aria-hidden="true"
      style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', border: '2px solid currentColor', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', flexShrink: 0 }}
    />
  )
}

// ---------------------------------------------------------------------------
// Shared chrome — identical to the conversation/empty scenes
// ---------------------------------------------------------------------------

function BadgeRow() {
  return (
    <div style={{ minHeight: 33, display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8, padding: '1px 1px 2px' }}>
      <AskBadge /><StateBadge /><span style={{ flex: 1 }} /><InfoButton />
    </div>
  )
}

function AskBadge() {
  return <button type="button" style={{ height: 30, padding: '0 7.5px 0 9.375px', display: 'inline-flex', alignItems: 'center', gap: 5.625, border: 0, borderRadius: 8, background: 'color-mix(in srgb, var(--info) 10%, transparent)', color: 'var(--info)', '--shadow-color': 'var(--info-rgb)', boxShadow: 'var(--shadow-tinted)', fontSize: 12, fontWeight: 500 }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4m0 4h.01" /></svg><span>询问</span><ChevronDown size={14} style={{ opacity: .6 }} /></button>
}

function StateBadge() {
  return <button type="button" style={{ height: 30, padding: '0 15px 0 11.25px', display: 'inline-flex', alignItems: 'center', gap: 5.625, border: 0, borderRadius: 8, background: 'color-mix(in srgb, var(--foreground) 4%, transparent)', color: 'var(--foreground)', '--shadow-color': 'var(--foreground-rgb)', boxShadow: 'var(--shadow-tinted)', fontSize: 12, fontWeight: 500 }}><span>待办</span><ChevronDown size={14} style={{ opacity: .6 }} /></button>
}

function InfoButton() {
  return <button type="button" style={{ height: 30, padding: '0 13.125px 0 11.25px', display: 'inline-flex', alignItems: 'center', gap: 5.625, flexShrink: 0, border: 0, borderRadius: 8, background: 'color-mix(in srgb, var(--background) 97%, var(--foreground) 3%)', '--shadow-color': 'var(--foreground-rgb)', boxShadow: 'var(--shadow-minimal)', color: 'color-mix(in srgb, var(--foreground) 80%, transparent)', fontSize: 12, fontWeight: 500 }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4m0 4h.01" /></svg><span>信息</span></button>
}

function ChatChrome({ title, children }) {
  return (
    <section aria-label="会话" style={{ height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--background)', color: 'var(--foreground)' }}>
      <header style={{ height: 42, minHeight: 42, display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 16, paddingRight: 8, position: 'relative', zIndex: 1 }}>
        <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', userSelect: 'none' }}>
          <button type="button" style={{ minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', border: 0, borderRadius: 6, color: 'var(--foreground)', background: 'transparent' }}>
            <h1 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600, lineHeight: 1.25 }}>{title}</h1><ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--fg-50)', transform: 'translateY(1px)' }} />
          </button>
        </div>
      </header>
      <div style={{ minHeight: 0, minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {/* ChatDisplay masked scroll area with the CHAT_LAYOUT column */}
        <main style={{ minHeight: 0, flex: 1, overflowY: 'auto', WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)', maskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)' }}>
          <div style={{ width: '100%', maxWidth: 840, boxSizing: 'border-box', margin: '0 auto', padding: '30px 18.75px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9.375 }}>
              {children}
            </div>
          </div>
        </main>
        <div style={{ width: '100%', maxWidth: 840, boxSizing: 'border-box', margin: '4px auto 0', padding: '1px 20px 16px' }}>
          <BadgeRow />
          <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 12, background: 'var(--background)', '--shadow-color': 'var(--foreground-rgb)', boxShadow: 'var(--shadow-middle)' }}>
            <textarea readOnly placeholder="想做什么?" style={{ display: 'block', width: '100%', minHeight: 88, maxHeight: 540, boxSizing: 'border-box', resize: 'none', padding: '15px 15px 11.25px 18.75px', border: 0, outline: 0, color: 'var(--foreground)', background: 'transparent', font: 'inherit', fontSize: 14, lineHeight: 1.25 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 8, borderTop: '1px solid color-mix(in srgb, var(--border) 50%, transparent)' }}>
              <div style={{ minWidth: 128, display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                <InputBadge icon={<PaperclipIcon />} label="附加文件" />
                <InputBadge icon={<DatabaseIcon />} label="选择数据源" chevron />
                <InputBadge icon={<FileTextIcon />} label="Work in Folder" chevron />
              </div>
              <div style={{ flex: 1 }} />
              <button type="button" aria-label="发送消息" style={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginLeft: 8, padding: 0, border: 0, borderRadius: 9999, color: 'var(--background)', background: 'var(--foreground)', opacity: .5 }}><ArrowUpIcon /></button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function PaperclipIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg> }
function DatabaseIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5V19A9 3 0 0 0 21 19V5" /><path d="M3 12A9 3 0 0 0 21 12" /></svg> }
function FileTextIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></svg> }
function ArrowUpIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></svg> }

function InputBadge({ icon, label, chevron = false }) {
  return <button type="button" aria-label={label} style={{ height: 28, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 8px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--foreground)', fontSize: 13 }}><span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span><span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: .5 }}>{label}</span>{chevron && <ChevronDown size={12} style={{ flexShrink: 0, opacity: .5 }} />}</button>
}

function UserMessageBubble({ text }) {
  return <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 11.25, width: '100%' }}>
    <div style={{ maxWidth: '80%', boxSizing: 'border-box', background: 'var(--user-message-bubble)', borderRadius: 16, padding: '13.125px 18.75px', color: 'var(--foreground)', fontSize: 14, lineHeight: 1.4286, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
  </div>
}

// ---------------------------------------------------------------------------
// Streaming state — one running assistant TurnCard (TurnCard.tsx):
// collapsible header with step-count badge + preview, expanded activity
// timeline (intermediate row → spinner + 思考中, tool row → spinner +
// displayName · intent) and the streaming ResponseCard (throttled content +
// 缓冲区 footer with spinner).
// ---------------------------------------------------------------------------

const streamingActivities = [
  { id: 'ac1', type: 'intermediate', status: 'running', content: '' },
  { id: 'ac2', type: 'tool', status: 'running', toolName: 'run_command', displayName: 'Bash', intent: 'git log --oneline -14' },
]

export function SourceChatStreaming() {
  return (
    <div data-route="chat/streaming" style={{ height: '100%', minWidth: 0 }}>
      <ChatChrome title="polaris 周报">
        <UserMessageBubble text="帮我把 polaris 仓库的 main 分支同步到最新，然后总结过去一周的提交。" />
        <StreamingTurn />
      </ChatChrome>
    </div>
  )
}

function StreamingTurn() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3.75 }}>
      {/* TurnCard activity section — expanded by default while streaming */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7.5, width: '100%', padding: '5.625px 5.625px 5.625px 11.25px', borderRadius: 8, color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', backgroundColor: 'transparent' }}>
          <ChevronDown size={14} style={{ flexShrink: 0, color: 'color-mix(in srgb, var(--foreground) 55%, transparent)' }} />
          <span style={{ flexShrink: 0, padding: '1.875px 5.625px', borderRadius: 4, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', fontSize: 10, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{streamingActivities.length}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.125 }}>Bash · git log --oneline -14</span>
        </div>
        {/* Expanded timeline — border-l-2 border-muted ml-[13px] pl-4 pr-2 */}
        <div style={{ borderLeft: '2px solid var(--muted)', marginLeft: 13, padding: '0 7.5px', paddingLeft: 15, display: 'flex', flexDirection: 'column' }}>
          {streamingActivities.map(activity => (
            <ActivityRow key={activity.id} activity={activity} />
          ))}
        </div>
      </div>
      {/* ResponseCard streaming branch: throttled content + Streaming... footer */}
      <div style={{ background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '11.25px 15px 11.25px 22.5px', fontSize: 14, lineHeight: 1.4286, color: 'var(--foreground)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          已将 polaris/main 同步到 origin/main (快进 14 个提交)。正在读取过去一周的提交记录…
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7.5, padding: '7.5px 15px', borderTop: '1px solid color-mix(in srgb, var(--border) 30%, transparent)', background: 'color-mix(in srgb, var(--muted) 20%, transparent)', color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', fontSize: 13.125 }}>
          <Spinner size={11} />
          <span>Streaming...</span>
        </div>
      </div>
    </div>
  )
}

// ActivityRow — intermediate rows show spinner + 思考中 while running
// (complete rows show MessageCircleDashed + stripped content); tool rows show
// the ActivityStatusIcon (spinner while running, CheckCircle2 success /
// accent Edit-Write glyphs when complete) and "DisplayName · Intent".
function ActivityRow({ activity }) {
  const isRunning = activity.status === 'running'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7.5, padding: '1.875px 0', color: activity.type === 'tool' ? 'color-mix(in srgb, var(--foreground) 75%, transparent)' : 'color-mix(in srgb, var(--foreground) 75%, transparent)', fontSize: 13.125, width: '100%', minWidth: 0 }}>
      {activity.type === 'intermediate' ? (
        <>
          <span style={{ display: 'inline-flex', flexShrink: 0, width: 14, height: 14, alignItems: 'center', justifyContent: 'center', color: 'color-mix(in srgb, var(--foreground) 75%, transparent)' }}>
            {isRunning ? <Spinner size={9} /> : <MessageCircleDashed size={14} />}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {isRunning ? 'Thinking...' : activity.content}
          </span>
        </>
      ) : (
        <>
          <span style={{ display: 'inline-flex', flexShrink: 0, width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}>
            {isRunning ? <Spinner size={9} /> : <CheckCircle2Icon size={14} />}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {activity.displayName} · {activity.intent}
          </span>
          <span style={{ flex: 1 }} />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Error state — user message followed by the ChatDisplay error system turn
// (MessageBubble error branch / ErrorMessage): destructive-tinted bubble with
// title, actions and the collapsible technical-details block.
// ---------------------------------------------------------------------------

export function SourceChatError() {
  return (
    <div data-route="chat/error" style={{ height: '100%', minWidth: 0 }}>
      <ChatChrome title="polaris 周报">
        <UserMessageBubble text="帮我把 polaris 仓库的 main 分支同步到最新，然后总结过去一周的提交。" />
        <ErrorMessageBubble />
      </ChatChrome>
    </div>
  )
}

function ErrorMessageBubble() {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 15 }}>
      <div style={{ maxWidth: '80%', boxSizing: 'border-box', borderRadius: 8, padding: '7.5px 15px 9.375px 18.75px', wordBreak: 'break-word', backgroundColor: 'oklch(from var(--destructive) l c h / 0.03)', '--shadow-color': 'var(--destructive-rgb)', boxShadow: 'var(--shadow-tinted)' }}>
        <div style={{ fontSize: 11.25, color: 'color-mix(in srgb, var(--destructive) 50%, transparent)', marginBottom: 1.875, fontWeight: 600 }}>模型服务超时</div>
        <p style={{ margin: 0, fontSize: 13.125, color: 'var(--destructive)' }}>连接模型服务失败：请求在 30 秒内未得到响应，请稍后重试或选择其他模型。</p>
        <div style={{ marginTop: 7.5, display: 'flex', flexWrap: 'wrap', gap: 5.625 }}>
          <button type="button" style={{ fontSize: 11.25, padding: '1.875px 7.5px', borderRadius: 4, border: '1px solid color-mix(in srgb, var(--destructive) 20%, transparent)', color: 'color-mix(in srgb, var(--destructive) 70%, transparent)', background: 'transparent', cursor: 'pointer' }}>重试</button>
        </div>
        <div style={{ marginTop: 7.5 }}>
          <button type="button" style={{ display: 'inline-flex', alignItems: 'center', gap: 3.75, fontSize: 11.25, color: 'color-mix(in srgb, var(--destructive) 70%, transparent)', border: 0, background: 'none', padding: 0, cursor: 'pointer' }}>
            <ChevronUp size={12} />
            <span>隐藏技术详情</span>
          </button>
          <div style={{ marginTop: 7.5, paddingTop: 7.5, borderTop: '1px solid color-mix(in srgb, var(--destructive) 20%, transparent)', fontSize: 11.25, color: 'color-mix(in srgb, var(--destructive) 60%, transparent)', fontFamily: 'var(--font-mono)', lineHeight: 1.6 }}>
            <div>{'POST https://api.polo.local/v1/chat/completions → 504 Gateway Timeout'}</div>
            <div>{'elapsed: 30.12s · retries: 0/1'}</div>
            <div style={{ marginTop: 3.75 }}>{'Raw: request timed out after 30000ms (code=ETIMEDOUT)'}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail state — a completed assistant turn in full (TurnCard expanded:
// timeline + TodoList, then the completed ResponseCard with its action
// footer). defaultExpanded shows the complete activity list at rest.
// ---------------------------------------------------------------------------

const detailActivities = [
  { id: 'ad1', type: 'intermediate', status: 'completed', content: '整理 changelog 条目结构' },
  { id: 'ad2', type: 'tool', status: 'completed', toolName: 'run_command', displayName: 'Bash', intent: 'git log --oneline HEAD~5', completed: true },
  { id: 'ad3', type: 'tool', status: 'completed', toolName: 'Write', displayName: 'Write', intent: 'changelog.md', completed: true },
]

const todos = [
  { status: 'completed', content: '读取时区修复的提交信息' },
  { status: 'completed', content: '生成 changelog 条目草稿' },
  { status: 'in_progress', content: '写入 changelog.md 并验证' },
]

export function SourceChatDetail() {
  return (
    <div data-route="chat/detail" style={{ height: '100%', minWidth: 0 }}>
      <ChatChrome title="polaris 周报">
        <UserMessageBubble text="把时区修复单独整理成一条 changelog 条目。" />
        <CompletedTurn />
      </ChatChrome>
    </div>
  )
}

function CompletedTurn() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3.75 }}>
      {/* TurnCard activity section — expanded */}
      <div>
        {/* Collapsed header (chevron + step badge + preview + actions) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7.5, width: '100%', padding: '5.625px 5.625px 5.625px 11.25px', borderRadius: 8, color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', backgroundColor: 'transparent' }}>
          <ChevronDown size={14} style={{ flexShrink: 0, color: 'color-mix(in srgb, var(--foreground) 55%, transparent)' }} />
          <span style={{ flexShrink: 0, padding: '1.875px 5.625px', borderRadius: 4, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', fontSize: 10, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{detailActivities.length}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.125 }}>Write · changelog.md</span>
        </div>
        <div style={{ borderLeft: '2px solid var(--muted)', marginLeft: 13, padding: '0 7.5px', paddingLeft: 15, display: 'flex', flexDirection: 'column' }}>
          {detailActivities.map(activity => (
            <DetailActivityRow key={activity.id} activity={activity} />
          ))}
        </div>
        {/* TodoList — separate bordered section below the timeline */}
        <div style={{ borderLeft: '2px solid var(--muted)', marginLeft: 13, paddingLeft: 15, padding: '6.25px 7.5px 3.75px 15px', display: 'flex', flexDirection: 'column', gap: 1.875 }}>
          <div style={{ color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', fontSize: 13.125, paddingBottom: 3.75 }}>Todo List</div>
          {todos.map((todo, index) => (
            <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 7.5, padding: '1.875px 0', fontSize: 13.125, color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', opacity: todo.status === 'completed' ? 0.5 : 1 }}>
              <span style={{ display: 'inline-flex', flexShrink: 0, width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}>
                {todo.status === 'completed' ? <CircleCheck size={14} style={{ color: 'var(--accent)' }} /> : todo.status === 'in_progress' ? <Spinner size={9} /> : <Circle size={14} style={{ color: 'color-mix(in srgb, var(--foreground) 50%, transparent)' }} />}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{todo.content}</span>
            </div>
          ))}
        </div>
      </div>
      {/* Completed ResponseCard: content (maxHeight 540 scroll, hover fullscreen
          button) + footer (Copy / Markdown | Branch). */}
      <div style={{ background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
        <div style={{ maxHeight: 540, overflowY: 'auto', padding: '11.25px 15px 11.25px 22.5px', fontSize: 14, lineHeight: 1.4286, color: 'var(--foreground)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {`changelog 草稿:

- fix(automations): 调度器现在按 Workspace 时区解释计划表达式
- 修复跨时区部署时定时任务提前/延后一小时的问题
- 新增时区选择器预览（下一次运行时间按本地时区展示）`}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7.5px 9.375px 7.5px 15px', borderTop: '1px solid color-mix(in srgb, var(--border) 30%, transparent)', background: 'color-mix(in srgb, var(--muted) 20%, transparent)', fontSize: 13.125 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11.25 }}>
            <button type="button" style={{ display: 'inline-flex', alignItems: 'center', gap: 5.625, color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', border: 0, background: 'none', padding: 0, cursor: 'pointer', fontSize: 13.125 }}><Copy size={14} /><span>复制</span></button>
            <button type="button" style={{ display: 'inline-flex', alignItems: 'center', gap: 5.625, color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', border: 0, background: 'none', padding: 0, cursor: 'pointer', fontSize: 13.125 }}><FileText size={14} /><span>Markdown</span></button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11.25 }}>
            <button type="button" aria-label="从此消息创建分叉" title="派生" style={{ width: 26.25, height: 26.25, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 4, color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', background: 'transparent', cursor: 'pointer' }}><GitBranch size={14} /></button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Detail-状态的活动行：completed tool → CheckCircle2 (success) or
// Edit/Write accent glyph; completed intermediate → MessageCircleDashed.
function DetailActivityRow({ activity }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7.5, padding: '1.875px 0', fontSize: 13.125, width: '100%', minWidth: 0, color: 'color-mix(in srgb, var(--foreground) 75%, transparent)' }}>
      {activity.type === 'intermediate' ? (
        <>
          <span style={{ display: 'inline-flex', flexShrink: 0, width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}><MessageCircleDashed size={14} style={{ color: 'color-mix(in srgb, var(--foreground) 75%, transparent)' }} /></span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{activity.content}</span>
        </>
      ) : (
        <>
          <span style={{ display: 'inline-flex', flexShrink: 0, width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}>
            {activity.toolName === 'Write' ? <FilePenLine size={14} style={{ color: 'var(--accent)' }} /> : <CheckCircle2Icon size={14} />}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{activity.displayName} · {activity.intent}</span>
        </>
      )}
    </div>
  )
}

// CheckCircle2 lucide path (filled circle + check).
function CheckCircle2Icon({ size }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--success)', flexShrink: 0 }} aria-hidden="true"><path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z" /><path d="m9 12 2 2 4-4" /></svg>
}