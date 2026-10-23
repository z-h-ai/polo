/**
 * Enterprise admin workflow URLs (POO-119).
 *
 * Restores the URL contract deleted with POO-116's home-space shortcuts: the
 * admin console is opened in the system browser at the member-management /
 * creator-center domain of the CURRENT enterprise, built from the trusted
 * admin origin returned by `adminGetStatus` (never a renderer-provided host).
 */

export type EnterpriseWorkflow = 'members' | 'publishing'

export function createEnterpriseWorkflowUrl(
  adminUrl: string,
  enterpriseId: string,
  workflow: EnterpriseWorkflow,
): string {
  // Same contract as the payment handoff (server-core payment-handoff.ts):
  // console pages live at the origin root of the trusted admin URL — a path
  // stored on adminUrl must neither leak into nor ambiguously combine with
  // the workflow route.
  const origin = new URL(adminUrl).origin
  const url = workflow === 'members'
    ? new URL(`/enterprise/${encodeURIComponent(enterpriseId)}/members`, origin)
    : new URL('/organization-apps', origin)
  if (workflow === 'publishing') url.searchParams.set('organizationId', enterpriseId)
  return url.toString()
}
