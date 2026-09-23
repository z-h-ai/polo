import { useState } from 'react'

// Exact prompt short/full strings from components/browser/empty-state-prompts.ts
// (sample prompts stay English in every locale; only the card title,
// description and safety hint are i18n'd — zh-Hans from zh-Hans.json).
const prompts = [
  ['HN: summarize top 10 stories in a table', 'Use the browser to open https://news.ycombinator.com and summarize the top 10 stories in a table with columns: title, source domain, points, comments, and why it matters.'],
  ["Product Hunt: compare today's top 5 launches", 'Use the browser to go to https://www.producthunt.com, find today\'s top 5 launches, and give me a comparison of product, category, pricing model, and ICP (ideal customer profile).'],
  ['Observability pricing matrix (DD/New Relic/Grafana)', 'Use the browser to open https://www.datadoghq.com/pricing, https://newrelic.com/pricing, and https://grafana.com/pricing; build a side-by-side pricing matrix with plan names, monthly cost, free-tier limits, data retention, and overage pricing.'],
  ['GitHub Docs: latest Actions updates', 'Use the browser to navigate to https://docs.github.com/en, find the latest updates related to GitHub Actions, and summarize actionable changes for a dev team in under 10 bullets.'],
  ['UK policy feed: 5 latest announcements', 'Use the browser to go to https://www.gov.uk/search/news-and-communications and collect the 5 most recent policy announcements, including title, date, department, and one-line summary.'],
  ['Booking.com: best Budapest stays next weekend', 'Use the browser to go to https://www.booking.com, search for hotels in Budapest for next weekend, and return the top 10 options sorted by review score with price per night, cancellation policy, and distance from city center.'],
  ['Kaggle: shortlist 8 churn datasets', 'Use the browser to open https://www.kaggle.com/datasets, search for customer churn, shortlist 8 high-quality datasets, and rank them by usability for a quick ML prototype.'],
  ['Status snapshot across OpenAI/GitHub/Cloudflare', 'Use the browser to visit https://status.openai.com, https://www.githubstatus.com, and https://www.cloudflarestatus.com; create a concise reliability snapshot with current status, active incidents, and affected components.'],
  ['Figma Community: trending design systems', 'Use the browser to go to https://www.figma.com/community, find top trending design system files this week, and summarize which ones are best for SaaS dashboard UI inspiration.'],
  ['Google Search docs: Core Web Vitals checklist', 'Use the browser to open https://developers.google.com/search/docs and extract all pages about Core Web Vitals; produce a practical checklist for engineering and SEO teams.'],
]
const border30 = 'color-mix(in srgb, var(--border) 30%, transparent)'
const muted20 = 'color-mix(in srgb, var(--fg-5) 100%, transparent)'

// browser-empty-state.tsx shell (bg-foreground-2 over bg-background) hosting
// packages/ui BrowserEmptyStateCard.tsx verbatim: p-8 wrapper, max-w-[700px]
// rounded-[8px] border-border/30 shadow-minimal card, header px-4 py-3
// bg-muted/20 with a 13px medium title, body pl-[22px] pr-[16px] py-3 with a
// 14px/relaxed 65% description and mt-3.5 space-y-1.5 prompt buttons
// (h-8 px-2.5 gap-1 rounded-[6px] shadow-minimal, 11px tabular-nums index,
// 12px/70% label), footer px-4 py-2.5 bg-muted/20 13px/55% safety hint.
export function SourceBrowserEmptyState() {
  const [selected, setSelected] = useState(null)
  return <div data-route="browser/empty-state" style={{ width: '100%', height: '100%', overflow: 'hidden', background: 'var(--fg-2)' }}><div style={{ width: '100%', height: '100%', overflow: 'auto', background: 'var(--background)' }}><div style={{ display: 'flex', width: '100%', minHeight: '100%', boxSizing: 'border-box', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
    <section style={{ width: '100%', maxWidth: 700, overflow: 'hidden', border: `1px solid ${border30}`, borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)' }}>
      <header style={{ display: 'flex', alignItems: 'center', padding: '11.25px 15px', borderBottom: `1px solid ${border30}`, background: muted20, userSelect: 'none' }}><h3 style={{ margin: 0, color: 'var(--foreground)', fontSize: 13, fontWeight: 500, letterSpacing: '-.025em' }}>浏览器已准备就绪 ;)</h3></header>
      <div style={{ padding: '11.25px 15px 11.25px 22px', fontSize: 13.125 }}><p style={{ margin: 0, color: 'color-mix(in srgb, var(--foreground) 65%, transparent)', lineHeight: 1.625 }}>让任何会话使用此浏览器（或打开另一个）来完成研究、填写表单、质检或数据提取等任务。</p><div style={{ display: 'grid', justifyItems: 'start', gap: 5.625, marginTop: 13.125 }}>{prompts.map(([short, full], index) => <button key={short} type="button" title={full} onClick={() => setSelected(full)} style={{ display: 'flex', maxWidth: '100%', height: 30, alignItems: 'center', gap: 3.75, padding: '0 11.25px', border: 0, borderRadius: 6, color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', fontSize: 12, textAlign: 'left', transition: 'background-color 150ms' }}><span style={{ width: 15, flexShrink: 0, color: 'color-mix(in srgb, var(--foreground) 40%, transparent)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{index + 1}.</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{short}</span></button>)}</div>{selected && <output aria-live="polite" style={{ display: 'none' }}>{selected}</output>}</div>
      <footer style={{ display: 'flex', alignItems: 'center', gap: 7.5, padding: '9.375px 15px', borderTop: `1px solid ${border30}`, color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', background: muted20, fontSize: 13 }}><p style={{ margin: 0 }}>Polo AI 仅在您要求时才会控制浏览器窗口。</p></footer>
    </section>
  </div></div></div>
}
