import type { AdminClient } from '@polo-ai/shared/admin'
import type { AssistantBillingJournalScope } from '@polo-ai/shared/admin/billing-outbox'
import type { AssistantBillingTransport } from './assistant-billing'

/** Session resolution remains owned by the trusted Admin session coordinator. */
export function createAssistantBillingTransport(
  session: (scope: AssistantBillingJournalScope) => Promise<{ client: AdminClient; accessToken: string }>,
): AssistantBillingTransport {
  // AdminClient owns the existing bounded HTTP deadline (15s by default).
  // Do not add a shorter caller timer: admission includes provider verification
  // and reservation, which may still be committing after a 5s disconnect.
  return {
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
