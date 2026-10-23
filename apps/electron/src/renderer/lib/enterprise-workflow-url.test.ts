import { describe, expect, it } from 'bun:test'
import { createEnterpriseWorkflowUrl } from './enterprise-workflow-url'

describe('createEnterpriseWorkflowUrl (POO-119)', () => {
  it('builds the member-management route of the clicked enterprise', () => {
    expect(createEnterpriseWorkflowUrl('https://admin.example.com', 'org-a', 'members'))
      .toBe('https://admin.example.com/enterprise/org-a/members')
  })

  it('encodes the enterprise id into the path segment', () => {
    expect(createEnterpriseWorkflowUrl('https://admin.example.com', 'org/.. id', 'members'))
      .toBe('https://admin.example.com/enterprise/org%2F..%20id/members')
  })

  it('keeps the creator center on its organizationId-scoped route', () => {
    expect(createEnterpriseWorkflowUrl('https://admin.example.com', 'org-a', 'publishing'))
      .toBe('https://admin.example.com/organization-apps?organizationId=org-a')
  })

  it('always lands on the admin origin root, matching the payment-handoff contract', () => {
    // A sub-path stored on adminUrl must not compose with (or be replaced by)
    // the workflow route — same rule as server-core payment-handoff.ts.
    expect(createEnterpriseWorkflowUrl('https://admin.example.com/console/', 'org-a', 'members'))
      .toBe('https://admin.example.com/enterprise/org-a/members')
    expect(createEnterpriseWorkflowUrl('https://admin.example.com/console/', 'org-a', 'publishing'))
      .toBe('https://admin.example.com/organization-apps?organizationId=org-a')
  })

  it('keeps a crafted-looking enterprise id on the trusted origin', () => {
    const url = new URL(createEnterpriseWorkflowUrl('https://admin.example.com', '../../evil', 'members'))
    expect(url.origin).toBe('https://admin.example.com')
    expect(url.pathname).toBe('/enterprise/..%2F..%2Fevil/members')
  })
})
