import type { BrowserPolicyResponse } from '@polo-ai/shared/admin/browser-policy-contract';
export interface BrowserPolicyScope {
    accountId: string;
    productSpaceId: string;
    adminOrigin: string;
}
let reader: ((scope: BrowserPolicyScope) => Promise<BrowserPolicyResponse>) | undefined;
export function setBrowserPolicyReader(value: (scope: BrowserPolicyScope) => Promise<BrowserPolicyResponse>): void { reader = value; }
export function readBrowserPolicy(scope: BrowserPolicyScope): Promise<BrowserPolicyResponse> { if (!reader)
    throw Error('Managed browser policy authority unavailable'); return reader(scope); }
