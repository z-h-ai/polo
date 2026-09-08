import { AppWindow, Archive, ChevronRight, CloudUpload, Columns2, Copy, Flag, FolderOpen, Inbox, ListFilter, MessageSquare, MoreHorizontal, Pencil, RefreshCw, Search, Send, Tag, Trash2, X } from 'lucide-react'

// Static session-sidebar data states. Translation sources:
//   - SessionList.tsx            (EntityList groups: date/status/unread + search
//     groups, empty screens, RenameDialog wiring)
//   - SessionItem.tsx            (EntityRow columns: status icon + signal
//     cluster, title highlight, platform pills, match badge / flag / time)
//   - SessionMenu.tsx            (row dropdown content — actions + submenus)
//   - SessionSearchHeader.tsx    (search bar + results row)
//   - entity-list.tsx            (SectionHeader / collapsible group header)
//   - entity-row.tsx             (row skeleton, selection bar, separators)
//   - entity-list-badge.tsx      (text pill for platform bindings)
//   - config/session-status-config.tsx + @polo-ai/shared/statuses
//     + colors/defaults.ts       (dynamic statuses: id/label/color/icons)
//   - utils/session.ts           (title/preview/time/highlight helpers)
//
// IPC/data-owned values are named deterministic fixtures, noted inline:
//   - fixtureStatuses — the workspace statuses/config.json default set (id,
//     label, color, icon from DEFAULT_STATUS_COLORS/DEFAULT_ICON_SVGS;
//     labels via the status.* zh-Hans keys), resolved for light theme
//   - fixtureSessions — the session list; titles are fixture `name` values
//     (getSessionTitle order: custom name > first user msg > preview)
//   - fixtureBindings — messaging bindings driving the platform pills
//   - relative times are frozen snapshots of formatDistanceToNowStrict with
//     the shortTimeLocale (e.g. 5分), so they do not drift at runtime
//   - match counts and the "Matches found (…)" hotkey text are fixtures
//
// Grouping UI follows entity-list.tsx: non-collapsible lists use SectionHeader
// (px-4 py-2 text-[11px] uppercase), collapsible groups use
// CollapsibleGroupHeader (ChevronRight rotates 90° when expanded; collapsed
// shows "label · count"). All copy is zh-Hans (zh-Hans.json flat keys).

const fg10 = 'color-mix(in srgb, var(--foreground) 10%, transparent)'
const fg5 = 'color-mix(in srgb, var(--foreground) 5%, transparent)'
const fg3 = 'color-mix(in srgb, var(--foreground) 3%, transparent)'
const fg40 = 'color-mix(in srgb, var(--foreground) 40%, transparent)'
const fg50 = 'color-mix(in srgb, var(--foreground) 50%, transparent)'
const fg60 = 'color-mix(in srgb, var(--foreground) 60%, transparent)'
const muted = 'var(--fg-50)'
const yellow50 = 'color-mix(in srgb, #fde047 50%, transparent)'
const yellow10 = 'color-mix(in srgb, #fde047 10%, transparent)'
const yellow30 = 'color-mix(in srgb, #fde047 30%, transparent)'
const yellow800 = '#854d0e'
const yellow900 = '#713f12'
const yellow600_20 = 'color-mix(in srgb, #ca8a04 20%, transparent)'

// ---- Fixtures ---------------------------------------------------------------

// Default workspace todo states (statuses/config.json defaults). Colors come
// from DEFAULT_STATUS_COLORS (foreground/50, success, info, accent), icons
// from DEFAULT_ICON_SVGS (currentColor strokes → colorable). Labels mirror
// the status.* zh-Hans keys (进行中 has no status.* key → config label).
const fixtureStatuses = [
  { id: 'todo', label: '待办', color: fg50, icon: <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />, category: 'open' },
  { id: 'in-progress', label: '进行中', color: 'var(--success)', icon: <><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 3a9 9 0 0 0 0 18" fill="currentColor" stroke="none" /></>, category: 'open' },
  { id: 'needs-review', label: '待审查', color: 'var(--info)', icon: <><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></>, category: 'open' },
  { id: 'done', label: '完成', color: 'var(--accent)', icon: <><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" /><path d="M8 12l3 3 5-5" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>, category: 'closed' },
  { id: 'cancelled', label: '已取消', color: fg50, icon: <><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" /><path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>, category: 'closed' },
]
const statusById = Object.fromEntries(fixtureStatuses.map(s => [s.id, s]))

// Session list fixture. `name`/`preview` feed getSessionTitle; `time` is a
// frozen snapshot of formatDistanceToNowStrict with the shortTimeLocale
// (floor). Signal cluster follows SessionItem: unread dot (accent), plan
// glyph (success), Spinner while isProcessing. `hasUnread` also suppresses
// 标记为未读 in the menu. Bindings drive the platform pills.
const fixtureSessions = [
  { id: 's-1', name: '分析 Polo 架构设计', status: 'in-progress', hasUnread: true, lastMessageRole: 'plan', time: '5分', isFlagged: false, isProcessing: false, bindings: ['telegram'] },
  { id: 's-2', name: '修复登录流程的认证 bug', status: 'todo', time: '25分', isFlagged: true, bindings: ['whatsapp'] },
  { id: 's-3', name: '实现搜索功能', status: 'needs-review', time: '2小时', isProcessing: true, bindings: [] },
  { id: 's-4', name: '审查 PR #42', status: 'done', time: '9小时', isFlagged: false, bindings: [] },
  { id: 's-5', name: '调试 API 响应处理', status: 'done', time: '1天', isFlagged: true, bindings: [] },
  { id: 's-6', name: null, preview: '训练本地模型时的参数调优笔记', status: 'todo', time: '2天', bindings: [] },
  { id: 's-7', name: '部署监控告警配置', status: 'cancelled', time: '4天', bindings: [] },
  { id: 's-8', name: '数据源接入文档整理', status: 'todo', time: '6天', bindings: [] },
]

// Platform pills (EntityListBadge variant="text", h-[18px] px-1.5 text-[10px]).
// Telegram sky (bg-sky-500/10 text-sky-600; dark: bg-sky-400/15 text-sky-300),
// WhatsApp emerald (bg-emerald-500/10 text-emerald-600; dark: bg-emerald-400/15
// text-emerald-300). Bindings are IPC data → named fixture.
const PILL = {
  telegram: { text: 'Telegram', bg: 'color-mix(in srgb, #0ea5e9 10%, transparent)', color: '#0284c7' },
  whatsapp: { text: 'WhatsApp', bg: 'color-mix(in srgb, #10b981 10%, transparent)', color: '#059669' },
}

// Unread/plan glyphs: inline SVGs from SessionItem (viewBox 0 0 25 24,
// h-3.5 w-3.5, text-accent / text-success).
function UnreadDot() {
  return <svg style={{ color: 'var(--accent)', width: 13.125, height: 13.125, flexShrink: 0 }} viewBox="0 0 25 24" fill="currentColor" aria-hidden="true"><g transform="translate(1.748, 0.7832)"><path fillRule="nonzero" d="M10.9952443,22 C8.89638276,22 7.01311428,21.5426195 5.34543882,20.6278586 C4.85718403,21.0547471 4.29283758,21.3901594 3.65239948,21.6340956 C3.01196138,21.8780319 2.3651823,22 1.71206226,22 C1.5028102,22 1.34111543,21.9466389 1.22697795,21.8399168 C1.11284047,21.7331947 1.05735697,21.6016979 1.06052745,21.4454262 C1.06369794,21.2891545 1.13820435,21.1347886 1.28404669,20.9823285 C1.5693904,20.6621622 1.77547197,20.3400901 1.9022914,20.0161123 C2.02911082,19.6921344 2.09252054,19.3090783 2.09252054,18.8669439 C2.09252054,18.4553015 2.02276985,18.0646223 1.88326848,17.6949064 C1.74376711,17.3251906 1.5693904,16.9383229 1.36013835,16.5343035 C1.15088629,16.1302841 0.941634241,15.6748094 0.732382188,15.1678794 C0.523130134,14.6609494 0.348753423,14.0682606 0.209252054,13.3898129 C0.0697506845,12.7113652 0,11.9147609 0,11 C0,9.40679141 0.271076524,7.93936244 0.813229572,6.5977131 C1.35538262,5.25606376 2.11946966,4.09164934 3.1054907,3.10446985 C4.09151175,2.11729037 5.25507998,1.35308385 6.59619542,0.811850312 C7.93731085,0.270616771 9.40366047,0 10.9952443,0 C12.5868281,0 14.0531777,0.270616771 15.3942931,0.811850312 C16.7354086,1.35308385 17.900562,2.11729037 18.8897536,3.10446985 C19.8789451,4.09164934 20.6446174,5.25606376 21.1867704,6.5977131 C21.7289235,7.93936244 22,9.40679141 22,11 C22,12.5932086 21.7289235,14.0606376 21.1867704,15.4022869 C20.6446174,16.7439362 19.8805303,17.9083507 18.8945093,18.8955301 C17.9084883,19.8827096 16.74492,20.6469161 15.4038046,21.1881497 C14.0626891,21.7293832 12.593169,22 10.9952443,22 Z" /></g></svg>
}
function PlanGlyph() {
  return <svg style={{ color: 'var(--success)', width: 13.125, height: 13.125, flexShrink: 0 }} viewBox="0 0 25 24" fill="currentColor" aria-hidden="true"><path fillRule="nonzero" d="M13.7207031,22.6523438 C13.264974,22.6523438 12.9361979,22.4895833 12.734375,22.1640625 C12.5325519,21.8385417 12.360026,21.4316406 12.2167969,20.9433594 L10.6640625,15.7871094 C10.5729167,15.4615885 10.5403646,15.1995443 10.5664062,15.0009766 C10.5924479,14.8024089 10.6998698,14.6022135 10.8886719,14.4003906 L20.859375,3.6484375 C20.9179688,3.58984375 20.9472656,3.52473958 20.9472656,3.453125 C20.9472656,3.38151042 20.921224,3.32291667 20.8691406,3.27734375 C20.8170573,3.23177083 20.7568359,3.20735677 20.6884766,3.20410156 C20.6201172,3.20084635 20.5566406,3.22851562 20.4980469,3.28710938 L9.78515625,13.296875 C9.5703125,13.4921875 9.36197917,13.601237 9.16015625,13.6240234 C8.95833333,13.6468099 8.70117188,13.609375 8.38867188,13.5117188 L3.11523438,11.9101562 C2.64648438,11.7669271 2.25911458,11.5960286 1.953125,11.3974609 C1.64713542,11.1988932 1.49414062,10.875 1.49414062,10.4257812 C1.49414062,10.0742188 1.63411458,9.77148438 1.9140625,9.51757812 C2.19401042,9.26367188 2.5390625,9.05859375 2.94921875,8.90234375 L19.7460938,2.46679688 C19.9739583,2.38216146 20.1871745,2.31542969 20.3857422,2.26660156 C20.5843099,2.21777344 20.764974,2.19335938 20.9277344,2.19335938 C21.2467448,2.19335938 21.4973958,2.28450521 21.6796875,2.46679688 C21.8619792,2.64908854 21.953125,2.89973958 21.953125,3.21875 C21.953125,3.38802083 21.9287109,3.5703125 21.8798828,3.765625 C21.8310547,3.9609375 21.7643229,4.17252604 21.6796875,4.40039062 L15.2832031,21.109375 C15.1009115,21.578125 14.8828125,21.952474 14.6289062,22.2324219 C14.375,22.5123698 14.0722656,22.6523438 13.7207031,22.6523438 Z" /></svg>
}

// SpinKit grid (baseline spinner equivalent of @polo-ai/ui Spinner).
function CubeSpinner({ size }) {
  const cubeStyle = { backgroundColor: 'currentColor', animation: 'spinner-grid 1.3s infinite ease-in-out', transform: 'scale3d(0.5,0.5,1)' }
  const delays = [0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0, 0.1, 0.2]
  return <span role="status" aria-label="加载中" style={{ display: 'inline-grid', gridTemplateColumns: 'repeat(3, 1fr)', width: size, height: size, gap: '0.08em', color: 'var(--foreground)' }}>{delays.map((delay, index) => <span key={index} style={{ ...cubeStyle, animationDelay: delay + 's' }} />)}</span>
}

// ---- Shared row building blocks ---------------------------------------------

// SectionHeader / CollapsibleGroupHeader (entity-list.tsx). `chevron` is a
// mustache — pass a truthy value to render the rotating chevron, `collapsed`
// renders the " · count" suffix.
function GroupHeader({ label, chevron, collapsed }) {
  return (
    <button type="button" style={{ position: 'relative', display: 'flex', width: '100%', alignItems: 'center', gap: 5.625, padding: '7.5px 15px', border: 0, background: 'none', color: 'var(--foreground)', cursor: 'pointer' }}>
      <span style={{ position: 'absolute', top: 1.875, bottom: 1.875, left: 7.5, right: 7.5, borderRadius: 6, background: 'transparent', pointerEvents: 'none' }} />
      {chevron ? <ChevronRight size={12} style={{ flexShrink: 0, color: fg60, transform: collapsed ? 'none' : 'rotate(90deg)', transition: 'transform 180ms' }} /> : null}
      <span style={{ display: 'block', maxWidth: '100%', fontSize: 11, fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase', color: muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}{collapsed ? <span style={{ color: fg50 }}> · {collapsed}</span> : null}</span>
    </button>
  )
}

function Pill({ platform }) {
  const p = PILL[platform]
  return <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, height: 18, padding: '0 5.625px', borderRadius: 4, background: p.bg, color: p.color, fontSize: 10, fontWeight: 500, whiteSpace: 'nowrap' }}>{p.text}</span>
}

// One EntityRow (titleTrailing branch). `after` renders the
// separator (pl-[38px] pr-4). Trailing slot: match badge / flag / time; when
// menu is open the MoreHorizontal button replaces it and stays visible.
function SessionRow({ s, after, selected = false, titleText, matchCount, menuOpen = false }) {
  const title = titleText ?? (s.name ?? '新聊天')
  return (
    <div className="session-item" style={{ position: 'relative' }} data-session-id={s.id}>
      {after ? <div style={{ padding: '0 15px 0 38px' }}><hr style={{ margin: 0, border: 0, height: 1, background: fg10 }} /></div> : null}
      <div style={{ position: 'relative', paddingLeft: 7.5, marginRight: 7.5 }}>
        {selected ? <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 2, background: 'var(--accent)' }} /> : null}
        <button type="button" style={{ display: 'flex', width: '100%', alignItems: 'flex-start', gap: 7.5, padding: '11.25px 15px 11.25px 7.5px', borderRadius: 8, border: 0, background: selected ? fg3 : 'transparent', color: 'var(--foreground)', textAlign: 'left', fontSize: 13.125, cursor: 'pointer', transition: 'background-color 75ms' }}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 5.625, minWidth: 0, flex: 1 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minWidth: 0 }}>
              <span style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 10 }}>
                <StatusIconButton statusId={s.status} />
                <SignalCluster s={s} />
              </span>
              <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--foreground)' }}>{title}</span>
              {s.bindings.length > 0 ? <span style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 3.75 }}>{s.bindings.map(p => <Pill key={p} platform={p} />)}</span> : null}
              <span style={{ display: 'flex', flexShrink: 0, alignItems: 'center', marginLeft: 'auto', position: 'relative', marginRight: -3.75 }}>
                {menuOpen ? (
                  <button type="button" aria-haspopup="menu" aria-expanded aria-label="更多操作" style={{ display: 'flex', padding: 3.75, borderRadius: 6, border: 0, background: fg10, cursor: 'pointer' }}><MoreHorizontal size={13.125} style={{ color: fg40 }} /></button>
                ) : <Trailing s={s} matchCount={matchCount} selected={selected} />}
              </span>
            </span>
          </span>
        </button>
      </div>
    </div>
  )
}

// SessionStatusIcon: !h-5 !w-5 rounded-full, color = resolvedColor when the
// icon is colorable (all default SVGs are); SessionStatusMenu popover is not
// rendered statically.
function StatusIconButton({ statusId }) {
  const st = statusById[statusId]
  return (
    <button type="button" aria-label="Change todo state" aria-haspopup="menu" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, flexShrink: 0, padding: 0, border: 0, borderRadius: '50%', background: 'transparent', color: st ? st.color : 'var(--foreground)' }}>
      {st ? <svg viewBox="0 0 24 24" style={{ width: '100%', height: '100%' }} aria-hidden="true">{st.icon}</svg> : <span style={{ width: 13.125, height: 13.125, fontSize: 13.125, lineHeight: 1 }}>●</span>}
    </button>
  )
}

// Signal cluster: flex column of unread/plan/processing glyphs, hidden with
// !w-0 opacity-0 -ml-[10px] when idle (SessionItem).
function SignalCluster({ s }) {
  const active = s.hasUnread || s.lastMessageRole === 'plan' || s.isProcessing
  if (!active) return null
  return (
    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', gap: 3.75, opacity: 1, marginLeft: 0, transition: 'all 200ms ease-out' }}>
      {s.isProcessing ? <CubeSpinner size={10} /> : null}
      {s.hasUnread ? <UnreadDot /> : null}
      {s.lastMessageRole === 'plan' ? <PlanGlyph /> : null}
    </span>
  )
}

function Trailing({ s, matchCount, selected }) {
  if (matchCount != null) {
    // Match badge (bg-yellow-300/10 …; selected uses the yellow-300/50 +
    // yellow-500 border variant) with --shadow-color pinned by selection.
    // The "Matches found (…)" tooltip is hardcoded English with action-hotkey
    // fixture values.
    return <span title="Matches found (J next, K prev)" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 24, padding: '1.875px 3.75px', borderRadius: 6, fontSize: 10, fontWeight: 500, fontVariantNumeric: 'tabular-nums', lineHeight: 1.25, whiteSpace: 'nowrap', boxShadow: 'var(--shadow-tinted)', border: `1px solid ${selected ? '#eab308' : yellow600_20}`, background: selected ? yellow50 : yellow10, color: selected ? yellow900 : yellow800 }}>{matchCount}</span>
  }
  if (s.isFlagged) return <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 3.75 }}><Flag size={13.125} style={{ color: 'var(--info)' }} /></span>
  return <span style={{ fontSize: 11, color: fg40, whiteSpace: 'nowrap' }}>{s.time}</span>
}

// ---- Search header (SessionSearchHeader.tsx) --------------------------------
function SearchHeader({ query, resultCount }) {
  return (
    <div style={{ flexShrink: 0, padding: '7.5px 7.5px 5.625px', borderBottom: '1px solid color-mix(in srgb, var(--border) 50%, transparent)' }}>
      <div style={{ position: 'relative', borderRadius: 8, boxShadow: 'var(--shadow-minimal)', background: 'color-mix(in srgb, var(--muted) 50%, transparent)' }}>
        <Search size={13.125} style={{ position: 'absolute', left: 9.375, top: '50%', transform: 'translateY(-50%)', color: muted }} />
        <input readOnly value={query} aria-label="搜索" style={{ width: '100%', height: 32, boxSizing: 'border-box', padding: '0 30px', border: 0, borderRadius: 8, outline: 0, background: 'transparent', color: 'var(--foreground)', fontSize: 13.125 }} />
        <button type="button" title="关闭搜索" style={{ position: 'absolute', right: 7.5, top: '50%', transform: 'translateY(-50%)', display: 'flex', padding: 1.875, border: 0, borderRadius: 3.75, background: 'none', color: muted, cursor: 'pointer' }}><X size={13.125} /></button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5.625, padding: '9.375px 7.5px 0', fontSize: 11.25 }}>
        <span style={{ color: muted }}>{`${resultCount} 个结果`}</span>
      </div>
    </div>
  )
}

// ---- Empty state (EntityListEmptyScreen) ------------------------------------
function EmptyInbox() {
  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 11.25, boxSizing: 'border-box', padding: '22.5px 22.5px 20%', textAlign: 'center' }}>
      <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'center', marginBottom: 7.5, color: muted }}><Inbox size={40} strokeWidth={1.5} /></div>
      <div style={{ display: 'flex', maxWidth: 360, flexDirection: 'column', alignItems: 'center', gap: 7.5, textAlign: 'center' }}>
        <div style={{ fontSize: 13.125, fontWeight: 500, letterSpacing: '-.025em' }}>暂无会话</div>
        <div style={{ color: muted, fontSize: 11.25, lineHeight: 1.375 }}>与智能体的会话将显示在这里。开始一个吧。</div>
      </div>
      <div style={{ display: 'flex', width: '100%', maxWidth: 360, minWidth: 0, alignItems: 'center', justifyContent: 'center', gap: 11.25, marginTop: 11.25 }}>
        <button type="button" style={{ display: 'inline-flex', height: 26.25, alignItems: 'center', padding: '0 11.25px', border: 0, borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}>新建会话</button>
      </div>
    </div>
  )
}

// ---- Data-state views -------------------------------------------------------

// date-grouped: 今天 / 昨天 / 8月30日 / 8月28日 collapsible groups (collapsed
// groups render "label · count"; date labels are frozen — runtime derives them
// via isToday/isYesterday/format with the date locale).
function DateGrouped() {
  const groups = [
    { label: '今天', items: [fixtureSessions[0], fixtureSessions[1], fixtureSessions[2], fixtureSessions[3]] },
    { label: '昨天', items: [fixtureSessions[4], fixtureSessions[5]] },
    { label: '8月30日', items: [fixtureSessions[6]] },
    { label: '8月28日', items: [fixtureSessions[7]], collapsed: 1 },
  ]
  let first = true
  return <>{groups.map(g => (<div key={g.label}>
    <GroupHeader label={g.label} chevron collapsed={g.collapsed ?? null} />
    {g.items.map(s => { const after = !first; first = false; return <SessionRow key={s.id} s={s} after={after} selected={s.id === 's-1'} /> })}
  </div>))}</>
}

// unread-mode: two fixed buckets 未读 (2) / 已读 (3); the read bucket is
// collapsed in this fixture ("已读 (3) · 3").
function UnreadMode() {
  const unread = [fixtureSessions[0], fixtureSessions[1]]
  const read = [fixtureSessions[2], fixtureSessions[3], fixtureSessions[4]]
  let first = true
  const row = s => { const after = !first; first = false; return <SessionRow key={s.id} s={s} after={after} /> }
  return <div>
    <GroupHeader label="未读 (2)" chevron collapsed={null} />
    {unread.map(row)}
    <GroupHeader label="已读 (3)" chevron collapsed={3} />
    {read.map(row)}
  </div>
}

// status-mode: one collapsible group per status in config order, rows sorted
// by lastMessageAt desc; the done group is collapsed here ("完成 · 1"). Group
// labels come from t(`status.${id}`) with the config label as fallback.
function StatusMode() {
  const groups = [
    { status: 'todo', items: [fixtureSessions[1], fixtureSessions[5], fixtureSessions[7]] },
    { status: 'in-progress', items: [fixtureSessions[0]] },
    { status: 'needs-review', items: [fixtureSessions[2]] },
    { status: 'done', items: [fixtureSessions[3], fixtureSessions[4]], collapsed: 1 },
    { status: 'cancelled', items: [fixtureSessions[6]] },
  ]
  let first = true
  return <>{groups.map(g => (
    <div key={g.status}>
      <GroupHeader label={statusById[g.status].label} chevron collapsed={g.collapsed ?? null} />
      {g.items.map(s => { const after = !first; first = false; return <SessionRow key={s.id} s={s} after={after} /> })}
    </div>
  ))}</>
}

// search: SessionSearchHeader + two flat groups (当前视图 matches / 其他对话);
// matching titles are highlighted with the query (highlightMatch), trailing
// shows the fixture match-count badges (12 / 4), first row selected.
function SearchState() {
  const query = 'Polo'
  const highlight = (text) => {
    const idx = text.toLowerCase().indexOf(query.toLowerCase())
    if (idx === -1) return text
    return <>{text.slice(0, idx)}<span style={{ background: yellow30, borderRadius: 2 }}>{text.slice(idx, idx + query.length)}</span>{text.slice(idx + query.length)}</>
  }
  return <div>
    <SearchHeader query="Polo" resultCount={4} />
    <GroupHeader label="当前视图" chevron={null} collapsed={null} />
    <SessionRow s={fixtureSessions[0]} titleText={highlight('分析 Polo 架构设计')} matchCount={12} selected after={false} />
    <SessionRow s={fixtureSessions[5]} titleText={highlight('训练本地模型时的参数调优笔记')} matchCount={4} after />
    <GroupHeader label="其他对话" chevron={null} collapsed={null} />
    <SessionRow s={fixtureSessions[2]} after={false} />
    <SessionRow s={fixtureSessions[3]} after />
  </div>
}

// ---- Menu surface (menu-open) ----------------------------------------------
// StyledDropdownMenuContent: popover-styled p-1 gap-0.5 min-w-40; items
// px-2 py-1.5 pr-4 text-sm gap-2 rounded-[4px] hover:bg-foreground/[0.03];
// sub-triggers hover:bg-foreground/10 + ChevronRight ml-auto size-4;
// separators bg-foreground/10 -mx-1 my-1. Content is SessionMenu.tsx against
// the s-1 fixture (hasUnread → 标记为未读 suppressed; labels submenu keeps
// its count badge). Submenu panels are not opened statically.
function MenuItem({ icon, label, count, destructive = false, info = false }) {
  return (
    <div role="menuitem" tabIndex={-1} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 7.5, padding: '5.625px 15px 5.625px 7.5px', borderRadius: 4, color: destructive ? 'var(--destructive)' : 'var(--foreground)', fontSize: 13.125, whiteSpace: 'nowrap' }}>
      <span style={{ display: 'inline-flex', flexShrink: 0, color: info ? 'var(--info)' : 'inherit' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {count != null ? <span style={{ fontSize: 10, color: muted, fontVariantNumeric: 'tabular-nums', marginRight: -9.375 }}>{count}</span> : null}
    </div>
  )
}
function SubTrigger({ icon, label, color }) {
  return (
    <div role="menuitem" tabIndex={-1} aria-haspopup="menu" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 7.5, padding: '5.625px 5.625px 5.625px 7.5px', borderRadius: 4, color: 'var(--foreground)', fontSize: 13.125, whiteSpace: 'nowrap' }}>
      <span style={{ display: 'inline-flex', flexShrink: 0, color: color ?? 'inherit' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      <ChevronRight size={16} style={{ marginLeft: 'auto', flexShrink: 0 }} />
    </div>
  )
}
function MenuSeparator() {
  return <hr style={{ height: 1, margin: '3.75px -3.75px', border: 0, background: fg10 }} />
}
function SessionMenuSurface() {
  const statusIcon = <svg viewBox="0 0 24 24" style={{ width: 13.125, height: 13.125 }} aria-hidden="true">{statusById['in-progress'].icon}</svg>
  return (
    <div role="menu" aria-label="会话操作" style={{ position: 'absolute', zIndex: 40, top: 48, right: 15, display: 'flex', flexDirection: 'column', gap: 1.875, width: 'max-content', minWidth: 160, boxSizing: 'border-box', padding: 3.75, borderRadius: 8, background: 'var(--background)', color: 'var(--foreground)', boxShadow: 'var(--shadow-modal-small)', fontSize: 11.25, whiteSpace: 'nowrap' }}>
      <MenuItem icon={<CloudUpload size={13.125} />} label="共享" />
      <MenuItem icon={<Send size={13.125} />} label="发送到 Workspace..." />
      <SubTrigger icon={<MessageSquare size={13.125} />} label="连接消息平台" />
      <MenuSeparator />
      {/* 状态 sub — current status is in-progress → success color */}
      <SubTrigger icon={statusIcon} label="状态" color={statusById['in-progress'].color} />
      <SubTrigger icon={<Tag size={13.125} />} label="标签" />
      <MenuItem icon={<Flag size={13.125} />} label="标记" info />
      <MenuItem icon={<Archive size={13.125} />} label="归档" />
      <MenuSeparator />
      <MenuItem icon={<Pencil size={13.125} />} label="重命名" />
      <MenuItem icon={<RefreshCw size={13.125} />} label="重新生成标题" />
      <MenuSeparator />
      <MenuItem icon={<Columns2 size={13.125} />} label="在新面板中打开" />
      <MenuItem icon={<AppWindow size={13.125} />} label="在新窗口中打开" />
      <MenuItem icon={<FolderOpen size={13.125} />} label="在 Finder 中显示" />
      <MenuItem icon={<Copy size={13.125} />} label="复制路径" />
      <MenuSeparator />
      <MenuItem icon={<Trash2 size={13.125} />} label="删除" destructive />
    </div>
  )
}

export function SourceSessionNavigator({ state }) {
  let body
  if (state === 'empty') body = <EmptyInbox />
  else if (state === 'unread-mode') body = <UnreadMode />
  else if (state === 'status-mode') body = <StatusMode />
  else if (state === 'search') body = <SearchState />
  else if (state === 'menu-open') {
    // Pinned row with its dropdown open (align="end" popover over the list).
    body = <div style={{ position: 'relative' }}><SessionRow s={fixtureSessions[0]} selected menuOpen /><SessionMenuSurface /></div>
  } else body = <DateGrouped />
  return (
    <div data-route={`conversations-navigator/${state}`} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, boxSizing: 'border-box' }}>
      <div className="source-navigator__header"><span className="source-navigator__header-title">所有会话</span><button type="button" className="source-navigator__header-button" aria-label="筛选聊天"><ListFilter /></button></div>
      <div role="listbox" aria-label="Sessions" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{body}</div>
    </div>
  )
}