import { AdminError, type AdminClient, type AssistantBillingCapabilities } from '@polo-ai/shared/admin'
import type { AssistantBillingJournalScope } from '@polo-ai/shared/admin/billing-outbox'
import type { AssistantBillingTransport } from './assistant-billing'
import { AssistantBillingCapability } from './assistant-billing-capability'

/** Session resolution remains owned by the trusted Admin session coordinator. */
export function createAssistantBillingTransport(
  session: (scope: AssistantBillingJournalScope) => Promise<{ client: AdminClient; accessToken: string }>,
): AssistantBillingTransport {
  const capability = new AssistantBillingCapability<AssistantBillingCapabilities>()
  // AdminClient owns the existing bounded HTTP deadline (15s by default).
  // Do not add a shorter caller timer: admission includes provider verification
  // and reservation, which may still be committing after a 5s disconnect.
  return {
    capabilities: (scope, context) => capability.read(scope, async () => {
      const s = await session(scope)
      return s.client.getAssistantBillingCapabilities()
    }, context?.signal),
    prepare: async (scope, runId, admission, context) => {
      context?.signal?.throwIfAborted()
      const s = await session(scope)
      context?.signal?.throwIfAborted()
      try { return await s.client.prepareAssistantRequest(s.accessToken, { runId, admission }, context) }
      catch (error) {
        // Re-probe only for the next request after rollback. This attempt is
        // unknown and must never fall back to start/admit or replay a model.
        if (error instanceof AdminError && [404, 405].includes(error.status ?? 0)) capability.invalidate(scope)
        throw error
      }
    },
    inspectRun: async (scope, runId) => { const s = await session(scope); return s.client.getBillingRun(s.accessToken, runId, scope.productSpaceId) },
    start: async (scope, input, context) => {
      context?.signal?.throwIfAborted()
      const s = await session(scope)
      context?.signal?.throwIfAborted()
      return s.client.startAssistantRun(s.accessToken, input, context)
    },
    admit: async (scope, runId, input, context) => {
      context?.signal?.throwIfAborted()
      const s = await session(scope)
      context?.signal?.throwIfAborted()
      return s.client.admitAppRequest(s.accessToken, runId, input, context)
    },
    report: async (scope, input) => { const s = await session(scope); return s.client.recordAppUsage(s.accessToken, input) },
    inspect: async (scope, runId, requestId) => { const s = await session(scope); return s.client.getAppRequest(s.accessToken, runId, requestId) },
    finish: async (scope, runId, input) => { const s = await session(scope); return s.client.finishAppRun(s.accessToken, runId, input) },
  }
}
