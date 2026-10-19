/**
 * Deep Link / Route Registry Parity
 *
 * Every view route that src/shared/routes.ts can build must survive the full
 * poloai:// deep-link round trip. The renderer consumes a deep link's view
 * route through parseRouteToNavigationState() (src/shared/route-parser.ts),
 * so the parity contract is:
 *   a) route-parser can parse every routes.view builder output;
 *   b) parseDeepLink(`poloai://${route}`) returns target.view === route;
 *   c) parseDeepLink(`poloai://workspace/{wsId}/${route}`) does the same
 *      with the workspace id attached.
 *
 * If routes.ts gains a new view builder (or a new view prefix) without the
 * COMPOUND_ROUTE_PREFIXES whitelist in src/main/deep-link.ts following, the
 * builder-coverage test fails first and the round-trip tests go red.
 *
 * Encoding note (verified against Bun's WHATWG URL implementation, the same
 * parser used by the main process): for the non-special poloai:// scheme,
 * URL.pathname preserves %XX percent-encoding as-is and URL.hostname keeps
 * its original case. routes.ts encodes label/view ids with
 * encodeURIComponent, so the viewRoute reconstructed inside parseDeepLink
 * (host + pathParts.join('/')) is byte-identical to the original route
 * string. Strict equality below is therefore intentional — no decoding or
 * normalization is applied to the assertion.
 */

import { describe, expect, it } from 'bun:test'
import { parseDeepLink } from '../deep-link'
import { routes } from '../../shared/routes'
import { parseRoute } from '../../shared/route-parser'

interface ViewRouteCase {
  /** routes.view builder exercised by this case (anti-drift: all builders must appear) */
  builder: keyof typeof routes.view
  /** Human-readable description of the builder arguments */
  args: string
  /** Route string produced by the builder */
  route: string
}

const VIEW_ROUTE_CASES: ViewRouteCase[] = [
  // Sessions navigator
  { builder: 'allSessions', args: 'no args', route: routes.view.allSessions() },
  { builder: 'allSessions', args: 'sess-1', route: routes.view.allSessions('sess-1') },
  { builder: 'flagged', args: 'no args', route: routes.view.flagged() },
  { builder: 'flagged', args: 'sess-2', route: routes.view.flagged('sess-2') },
  { builder: 'archived', args: 'no args', route: routes.view.archived() },
  { builder: 'archived', args: 's', route: routes.view.archived('s') },
  { builder: 'state', args: 'st1', route: routes.view.state('st1') },
  { builder: 'state', args: 'st1, s', route: routes.view.state('st1', 's') },
  { builder: 'label', args: 'lbl', route: routes.view.label('lbl') },
  { builder: 'label', args: 'lbl, s', route: routes.view.label('lbl', 's') },
  // Encoded label ids (space / non-ASCII / slash) must round-trip byte-identical.
  { builder: 'label', args: '"my label", s', route: routes.view.label('my label', 's') },
  { builder: 'label', args: '"团队/lead", s', route: routes.view.label('团队/lead', 's') },
  { builder: 'view', args: 'v1', route: routes.view.view('v1') },
  { builder: 'view', args: 'v1, s', route: routes.view.view('v1', 's') },
  { builder: 'view', args: '"saved view 1", s', route: routes.view.view('saved view 1', 's') },

  // Sources navigator
  { builder: 'sources', args: 'no args', route: routes.view.sources() },
  { builder: 'sources', args: 'sourceSlug: github', route: routes.view.sources({ sourceSlug: 'github' }) },
  { builder: 'sources', args: 'type: api', route: routes.view.sources({ type: 'api' }) },
  { builder: 'sources', args: 'type: mcp, sourceSlug: my-mcp', route: routes.view.sources({ type: 'mcp', sourceSlug: 'my-mcp' }) },
  { builder: 'sources', args: 'type: local', route: routes.view.sources({ type: 'local' }) },
  { builder: 'sourcesApi', args: 'no args', route: routes.view.sourcesApi() },
  { builder: 'sourcesApi', args: 'gmail', route: routes.view.sourcesApi('gmail') },
  { builder: 'sourcesMcp', args: 'ctx', route: routes.view.sourcesMcp('ctx') },
  { builder: 'sourcesLocal', args: 'no args', route: routes.view.sourcesLocal() },

  // Skills navigator
  { builder: 'skills', args: 'no args', route: routes.view.skills() },
  { builder: 'skills', args: 'my-skill', route: routes.view.skills('my-skill') },

  // Automations navigator
  { builder: 'automations', args: 'no args', route: routes.view.automations() },
  { builder: 'automations', args: 'automationId: am-2', route: routes.view.automations({ automationId: 'am-2' }) },
  { builder: 'automations', args: 'type: scheduled', route: routes.view.automations({ type: 'scheduled' }) },
  { builder: 'automations', args: 'type: event, automationId: am-1', route: routes.view.automations({ type: 'event', automationId: 'am-1' }) },
  { builder: 'automations', args: 'type: agentic', route: routes.view.automations({ type: 'agentic' }) },
  { builder: 'automationsScheduled', args: 'no args', route: routes.view.automationsScheduled() },
  { builder: 'automationsScheduled', args: 'am-3', route: routes.view.automationsScheduled('am-3') },
  { builder: 'automationsEvent', args: 'am-4', route: routes.view.automationsEvent('am-4') },
  { builder: 'automationsAgentic', args: 'no args', route: routes.view.automationsAgentic() },

  // Settings navigator
  { builder: 'settings', args: 'no args', route: routes.view.settings() },
  { builder: 'settings', args: 'shortcuts', route: routes.view.settings('shortcuts') },
]

describe('deep-link / routes.view parity', () => {
  it('covers every routes.view builder (anti-drift)', () => {
    const covered = new Set(VIEW_ROUTE_CASES.map(c => c.builder))
    const declared = new Set(Object.keys(routes.view) as Array<keyof typeof routes.view>)
    expect([...covered].sort()).toEqual([...declared].sort())
  })

  for (const { builder, args, route } of VIEW_ROUTE_CASES) {
    describe(`routes.view.${builder}(${args}) -> ${route}`, () => {
      it('is parseable by route-parser', () => {
        expect(parseRoute(route)).not.toBeNull()
      })

      it('round-trips through a bare poloai:// compound deep link', () => {
        const target = parseDeepLink(`poloai://${route}`)
        expect(target).not.toBeNull()
        expect(target?.view).toBe(route)
      })

      it('round-trips through a workspace-targeted deep link', () => {
        const target = parseDeepLink(`poloai://workspace/ws-1/${route}`)
        expect(target).not.toBeNull()
        expect(target?.workspaceId).toBe('ws-1')
        expect(target?.view).toBe(route)
      })
    })
  }
})
