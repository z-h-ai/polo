import { useState } from 'react'

// Exact prompt short/full strings from components/browser/empty-state-prompts.ts.
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

// browser-empty-state.tsx -> BrowserEmptyStateCard.tsx. The native BrowserView
// itself is intentionally absent; this is its real first-load HTML surface.
export function SourceBrowserEmptyState() {
  const [selected, setSelected] = useState(null)
  return <div data-route="browser/empty-state" style={{ width: '100%', height: '100%', overflow: 'hidden', background: 'var(--foreground-2, var(--background))' }}><div style={{ width: '100%', height: '100%', overflow: 'auto', background: 'var(--background)' }}><div style={{ display: 'flex', width: '100%', minHeight: '100%', boxSizing: 'border-box', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
    <section style={{ width: '100%', maxWidth: 700, overflow: 'hidden', border: '1px solid color-mix(in srgb, var(--border) 30%, transparent)', borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)' }}>
      <header style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid color-mix(in srgb, var(--border) 30%, transparent)', background: 'var(--foreground-2, var(--background))', userSelect: 'none' }}><h3 style={{ margin: 0, color: 'var(--foreground)', fontSize: 13, fontWeight: 500, letterSpacing: '-.01em' }}>This browser is ready for your Agents - and you ;)</h3></header>
      <div style={{ padding: '12px 16px 12px 22px', fontSize: 14 }}><p style={{ margin: 0, color: 'color-mix(in srgb, var(--foreground) 65%, transparent)', lineHeight: 1.625 }}>Ask any session to use this browser (or open another one) to complete tasks like research, form filling, QA checks, or data extraction.</p><div style={{ display: 'grid', justifyItems: 'start', gap: 6, marginTop: 14 }}>{prompts.map(([short, full], index) => <button key={short} type="button" title={full} onClick={() => setSelected(full)} style={{ display: 'flex', maxWidth: '100%', height: 32, alignItems: 'center', gap: 4, padding: '0 10px', border: 0, borderRadius: 6, color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', fontSize: 12, textAlign: 'left' }}><span style={{ width: 16, flexShrink: 0, color: 'color-mix(in srgb, var(--foreground) 40%, transparent)', fontSize: 11 }}>{index + 1}.</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{short}</span></button>)}</div>{selected && <output aria-live="polite" style={{ display: 'none' }}>{selected}</output>}</div>
      <footer style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderTop: '1px solid color-mix(in srgb, var(--border) 30%, transparent)', color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', background: 'var(--foreground-2, var(--background))', fontSize: 13 }}><p style={{ margin: 0 }}>Polo AI only control browser windows when you ask them to.</p></footer>
    </section>
  </div></div></div>
}
