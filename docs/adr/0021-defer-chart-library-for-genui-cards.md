# Defer a chart library for Generative UI cards

Status: accepted for POO-102 (Generative UI P1), 2026-10-18.

POO-101 introduced five declarative render_ui card types without a chart
component, and POO-102 adds canvas apps (generate_app) whose HTML bundles are
statically scanned to be fully self-contained. Both tracks keep asking for
charts, so the library question is decided now and implementation is deferred
out of P1.

Decision: **no chart library in P1.** Inline cards gain charts only through the
existing `data-table` + textual stat components; canvas apps that need plots
embed a single-file chart inline (hand-written SVG or a vendored single-file
snippet) inside their own 512KB self-contained bundle, exactly like any other
inline asset. The planned transition path is Mermaid's `xychart` syntax in
Markdown blocks, which already renders in the app's Markdown pipeline without
adding a dependency.

Reasons: every candidate library (Chart.js, ECharts, Recharts, visx) either
ships a runtime CDN/load path that the generate_app external-reference scan
exists to reject, or adds hundreds of KB to the shared renderer bundle for a
card type with no committed consumer yet. A declarative chart card also needs
a schema and registry decision that P2's `ui-event` interaction loop will
influence (live data updates change the props shape), so deciding now would
guess.

Revisit when: (a) a P2 interaction loop lands and the card schema stabilizes,
or (b) canvas apps need server-side-rendered charts the model cannot express
as inline SVG. At that point the library choice is confined to two seams: the
render_ui registry (one new card type) or the session-tool bundle policy (a
single additional allowlisted vendored file), and this ADR is superseded.
