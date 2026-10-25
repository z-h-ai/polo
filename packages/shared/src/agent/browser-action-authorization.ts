import { i18n } from '../i18n';
import { createHash, randomUUID } from 'node:crypto';
import { browserPolicyResponseSchema, type BrowserPolicyResponse } from '../admin/browser-policy-contract';
export interface BrowserActionFacts {
    browserId: string;
    documentId: string;
    url: string;
    frameUrl: string;
    connected: boolean;
    tag: string;
    role: string;
    name: string;
    href: string;
    inputType: string;
    formText: string;
    fields: Record<string, string>;
    hasInlineMutation: boolean;
    targetId?: string;
    zoomFactor?: number;
    incomplete?: boolean;
}
export interface BrowserActionScope {
    accountId: string;
    productSpaceId: string;
    sessionId: string;
    generation: number;
    adminOrigin?: string;
    accountGeneration?: number;
    fenceGeneration?: number;
}
export interface BrowserUserAuthority {
    id: string;
    text: string;
}
export interface BrowserActionPresentation {
    phase: 'awaiting_authorization' | 'invalidated_before_dispatch' | 'dispatched_outcome_unknown';
    fields: Array<[
        string,
        string
    ]>;
    actionDigest: string;
}
export interface BrowserActionConfirmation {
    requestId: string;
    scope: BrowserActionScope;
    actionDigest: string;
    description: string;
    browserAction: BrowserActionPresentation;
}
export interface BrowserActionAudit {
    actionId: string;
    scopeDigest: string;
    sessionId: string;
    generation: number;
    command: string;
    commandDigest: string;
    sourceMessageIds: string[];
    kind?: Kind;
    policyVersion?: string;
    actionDigest?: string;
    confirmationRequestId?: string;
    result: string;
    reason?: string;
}
export interface BrowserActionDispatchLease {
    id: string;
    issuedAt: number;
    expiresAt: number;
    scope: BrowserActionScope;
    signal?: AbortSignal;
}
export interface BrowserActionDecision {
    allowed: boolean;
    alwaysAllow?: boolean;
    actionDigest: string;
}
export const browserActionDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CORE_DANGER = /(保存|删除|移除|提交|支付|付款|购买|下单|发送|转账|注销|\b(?:save|delete|remove|submit|pay|payment|checkout|purchase|buy|send|transfer|logout)\b)/i;
const ORDINARY_TARGET = /(打开|详情|展开|折叠|搜索|查找|筛选|下一页|上一页|帮助|\b(?:open|details|expand|collapse|search|filter|next page|previous page|help)\b)/i;
const NEGATED_OR_CONDITIONAL = /(不要|不许|禁止|别|仅查看|只看|先问|先确认|如果|除非|\b(?:not|don't|never|only view|ask first|if|unless)\b)/i;
const INTENT = { pay: /(支付|付款|购买|下单|\b(?:pay|purchase|buy)\b)/i, send: /(发送|\bsend\b)/i, delete: /(删除|移除|\b(?:delete|remove)\b)/i, save: /(保存|提交|\b(?:save|submit)\b)/i };
type Kind = 'ordinary' | 'pay' | 'send' | 'delete' | 'save' | 'unknown';
function kindOf(parts: string[], facts: BrowserActionFacts, policy: BrowserPolicyResponse): Kind {
    const verb = parts[0]?.toLowerCase(), label = facts.name + ' ' + facts.href;
    if (facts.incomplete)
        return 'unknown';
    const text = label + ' ' + facts.formText + ' ' + parts.slice(1).join(' ');
    const configuredDanger = policy.policy.dangerousWords.some(word => text.toLowerCase().includes(word.toLowerCase()));
    if (verb === 'evaluate' || verb === 'drag' || verb === 'upload')
        return 'unknown';
    if (verb === 'select' && facts.tag !== 'select')
        return 'unknown';
    if (['fill', 'type', 'select', 'paste'].includes(verb ?? ''))
        return facts.hasInlineMutation || configuredDanger ? 'unknown' : 'ordinary';
    if (['navigate', 'back', 'forward'].includes(verb ?? ''))
        return CORE_DANGER.test(text) || configuredDanger ? 'unknown' : 'ordinary';
    if (verb === 'scroll')
        return 'ordinary';
    if (verb === 'key' && !/^(Enter|Return|Space| )$/i.test(parts[1] ?? ''))
        return 'unknown';
    // Every keyboard path is classified from its focused target and form, including
    // modifiers. Neither Ctrl+Enter nor Ctrl+S gets an early safe-key exemption.
    if (/(支付|付款|\b(?:pay|payment|checkout|purchase|buy)\b)/i.test(text))
        return 'pay';
    if (/(发送|\bsend\b)/i.test(text))
        return 'send';
    if (/(删除|移除|注销|\b(?:delete|remove)\b)/i.test(text))
        return 'delete';
    if (CORE_DANGER.test(text))
        return 'save';
    if (configuredDanger || verb === 'key')
        return 'unknown';
    if (facts.role === 'tab' || facts.tag === 'a' && facts.href.startsWith('http') || ORDINARY_TARGET.test(label))
        return 'ordinary';
    return 'unknown';
}
const REQUIRED_FIELDS: Record<Exclude<Kind, 'ordinary' | 'unknown'>, string[]> = { pay: ['orderId', 'recipient', 'amount', 'currency'], send: ['recipient', 'content'], delete: ['objectId'], save: ['objectId'] };
const normalize = (value: string) => value.trim();
function extractedAuthority(kind: Exclude<Kind, 'ordinary' | 'unknown'>, text: string): Record<string, string> {
    // Only complete affirmative command templates carry reusable authority.
    // Quoted page text, questions, conditions and explanatory prose cannot match.
    const parsed: Record<string, string> = {};
    const command = normalize(text);
    if (kind === 'pay') {
        const match = command.match(/^(?:请\s*)?(?:支付|付款|购买|下单|pay|purchase|buy)\s*(?:订单|order)\s*[:：#]?\s*(.+?)\s+(?:给|收款方|to|recipient)\s*[:：]?\s*(.+?)\s+(?:(?:金额|amount)\s*[:：]?\s*)?(\d+(?:\.\d+)?)\s*([A-Z]{3}|人民币|元)[。.!！]?$/i);
        if (match) {
            parsed.orderId = normalize(match[1]!);
            parsed.recipient = normalize(match[2]!);
            parsed.amount = match[3]!;
            parsed.currency = ['人民币', '元'].includes(match[4]!) ? 'CNY' : match[4]!.toUpperCase();
        }
    }
    else if (kind === 'send') {
        const match = command.match(/^(?:请\s*)?(?:发送|send)\s*(?:给|接收人|收件人|to|recipient)\s*[:：]?\s*(.+?)\s+(?:内容|content|message)\s*[:：]?\s*[「“"]([\s\S]*)[」”"][。.!！]?$/i);
        if (match) {
            parsed.recipient = normalize(match[1]!);
            parsed.content = match[2]!;
        }
    }
    else {
        const action = kind === 'delete' ? '删除|移除|delete|remove' : '保存|提交|save|submit';
        const match = command.match(new RegExp('^(?:请\\s*)?(?:' + action + ')(?:\\s*(?:对象|object))?\\s*[:：]?\\s*[「“"]([^」”"]+)[」”"][。.!！]?$', 'i'));
        if (match)
            parsed.objectId = normalize(match[1]!);
    }
    return parsed;
}
function canonicalAmount(value: string): string {
    if (!/^\d+(?:\.\d+)?$/.test(value))
        return value;
    const [integer, fraction] = value.split('.');
    const whole = integer!.replace(/^0+(?=\d)/, '');
    const decimals = fraction?.replace(/0+$/, '');
    return decimals ? whole + '.' + decimals : whole;
}
function originalAuthority(kind: Kind, facts: BrowserActionFacts, messages: BrowserUserAuthority[]): boolean {
    if (kind === 'ordinary' || kind === 'unknown')
        return false;
    return messages.some(m => {
        if (NEGATED_OR_CONDITIONAL.test(m.text) || !INTENT[kind].test(m.text))
            return false;
        const parsed = extractedAuthority(kind, m.text);
        return REQUIRED_FIELDS[kind].every(key => parsed[key] !== undefined && (key === 'amount' ? canonicalAmount(facts.fields[key]!) === canonicalAmount(parsed[key]!) : key === 'currency' ? facts.fields[key]!.toUpperCase() === parsed[key] : facts.fields[key] === parsed[key]));
    });
}
function presentation(kind: Kind, facts: BrowserActionFacts, digest: string): BrowserActionPresentation {
    const labels: Record<string, string> = { orderId: '订单', objectId: '对象', recipient: kind === 'pay' ? '收款方' : '接收人', amount: '金额', currency: '币种', content: '消息内容' };
    const fields: Array<[
        string,
        string
    ]> = [['网站', new URL(facts.frameUrl || facts.url).origin], ['操作', ({ pay: '支付订单', send: '发送消息', delete: '删除', save: '保存或提交', ordinary: '页面操作', unknown: '待核对操作' })[kind]]];
    for (const k of (kind === 'ordinary' || kind === 'unknown' ? [] : REQUIRED_FIELDS[kind]))
        if (facts.fields[k])
            fields.push([labels[k]!, facts.fields[k]!]);
    fields.push(['目标', facts.name || facts.role || facts.tag]);
    return { phase: 'awaiting_authorization', fields, actionDigest: digest };
}
/** Trusted native dispatcher proved that no input was sent. */
export class BrowserActionNotDispatched extends Error {
}
export class BrowserActionAuthorization {
    private active = new Map<string, {
        scope: string;
        resolve: (d: BrowserActionDecision) => void;
        digest: string;
    }>();
    private cancellationGeneration = 0;
    private dispatches = new Set<AbortController>();
    private operations = new Map<string, Promise<unknown>>();
    private operationScope = "";
    constructor(private readonly deps: {
        audit?: (event: BrowserActionAudit) => void | Promise<void>;
        scope: () => BrowserActionScope;
        assertCurrent: (scope: BrowserActionScope) => void;
        facts: (parts: string[]) => Promise<BrowserActionFacts>;
        policy: (scope: BrowserActionScope) => Promise<BrowserPolicyResponse>;
        userMessages: () => BrowserUserAuthority[];
        confirm: (request: BrowserActionConfirmation) => void;
        settled?: (requestId: string, phase: 'invalidated_before_dispatch' | 'dispatched_outcome_unknown') => void;
        closed?: (requestId: string) => void;
        signal?: () => AbortSignal | undefined;
    }) { }
    async readPolicy(): Promise<BrowserPolicyResponse> {
        const scope = this.deps.scope();
        this.deps.assertCurrent(scope);
        const p = browserPolicyResponseSchema.parse(await this.deps.policy(scope));
        this.deps.assertCurrent(scope);
        if (p.productSpaceId !== scope.productSpaceId)
            throw Error('Browser policy changed ProductSpace');
        if (p.policyDigest !== browserActionDigest(p.policy))
            throw Error('Browser policy digest mismatch');
        return p;
    }
    resolve(requestId: string, scope: BrowserActionScope, decision: BrowserActionDecision): boolean {
        const pending = this.active.get(requestId);
        if (!pending || pending.scope !== browserActionDigest(scope) || pending.digest !== decision.actionDigest || decision.alwaysAllow === true)
            return false;
        try {
            this.deps.assertCurrent(scope);
        }
        catch {
            return false;
        }
        this.active.delete(requestId);
        pending.resolve(decision);
        return true;
    }
    cancel(): void {
        this.cancellationGeneration++;
        for (const controller of this.dispatches)
            controller.abort();
        for (const [id, p] of this.active) {
            this.active.delete(id);
            p.resolve({ allowed: false, actionDigest: p.digest });
        }
    }
    async perform<T>(parts: string[], dispatch: (facts: BrowserActionFacts, lease: BrowserActionDispatchLease) => Promise<T>, options: {
        automatic?: boolean;
    } = {}): Promise<T> {
        const scope = this.deps.scope();
        this.deps.assertCurrent(scope);
        const auditBase = { actionId: randomUUID(), scopeDigest: browserActionDigest(scope), sessionId: scope.sessionId, generation: scope.generation, command: parts[0] ?? '', commandDigest: browserActionDigest(parts), sourceMessageIds: this.deps.userMessages().map(message => message.id) };
        const scopeKey = browserActionDigest(scope);
        if (this.operationScope !== scopeKey) {
            this.cancel();
            this.operations.clear();
            this.operationScope = scopeKey;
        }
        const cancellationGeneration = this.cancellationGeneration;
        const assertNotCancelled = () => { if (cancellationGeneration !== this.cancellationGeneration)
            throw new BrowserActionNotDispatched('Browser action cancelled before dispatch; nothing was executed'); };
        const policy = await this.readPolicy();
        assertNotCancelled();
        if (options.automatic && !policy.policy.autoAcceptEnabled)
            throw Error("Browser automatic execution disabled by current policy");
        const facts = await this.deps.facts(parts);
        assertNotCancelled();
        this.deps.assertCurrent(scope);
        if (!facts.connected)
            throw Error('Browser target invalidated before dispatch; nothing was executed');
        const userSource = browserActionDigest(this.deps.userMessages());
        const kind = kindOf(parts, facts, policy);
        if (kind !== 'ordinary' && kind !== 'unknown' && REQUIRED_FIELDS[kind].some(key => !facts.fields[key])) {
            await this.deps.audit?.({ ...auditBase, kind, result: 'not_dispatched', reason: 'missing_business_facts' });
            throw Error('Browser action consequence unclear: required business facts are missing. Re-observe and replan; nothing was executed.');
        }
        if (kind === 'unknown') {
            await this.deps.audit?.({ ...auditBase, kind, result: 'not_dispatched', reason: 'consequence_unclear' });
            throw Error('Browser action consequence unclear: re-observe and replan; ask the user if still unclear. Nothing was executed.');
        }
        const digest = browserActionDigest({ scope, parts, facts, userSource, policyVersion: policy.configVersion, policyDigest: policy.policyDigest });
        // Business identity survives redirects; an uncertain dispatch cannot be retried as a new click.
        const operationKey = kind === 'ordinary' ? randomUUID() : browserActionDigest({ scope, kind, fields: facts.fields, userSource });
        const prior = this.operations.get(operationKey);
        if (prior)
            return prior as Promise<T>;
        if (this.operations.size >= 256)
            throw Error('Browser action history capacity reached; start a new turn');
        let requestId: string | undefined;
        const audit = (result: string, reason?: string) => this.deps.audit?.({ ...auditBase, kind, policyVersion: policy.configVersion, actionDigest: digest, confirmationRequestId: requestId, result, reason });
        const run = async () => {
            if (kind !== 'ordinary' && !originalAuthority(kind, facts, this.deps.userMessages())) {
                requestId = 'browser-action-' + randomUUID();
                await audit('confirmation_requested');
                assertNotCancelled();
                const decision = await new Promise<BrowserActionDecision>((resolve, reject) => {
                    const signal = this.deps.signal?.();
                    if (signal?.aborted) {
                        reject(Error('Browser action cancelled before dispatch'));
                        return;
                    }
                    const timer = setTimeout(() => { this.active.delete(requestId!); resolve({ allowed: false, actionDigest: digest }); }, 120000);
                    const abort = () => { this.active.delete(requestId!); clearTimeout(timer); resolve({ allowed: false, actionDigest: digest }); };
                    signal?.addEventListener('abort', abort, { once: true });
                    this.active.set(requestId!, { scope: browserActionDigest(scope), digest, resolve: d => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(d); } });
                    try {
                        this.deps.confirm({ requestId: requestId!, scope, actionDigest: digest, description: i18n.t('browserAuthorization.description'), browserAction: presentation(kind, facts, digest) });
                    }
                    catch (e) {
                        abort();
                        reject(e);
                    }
                });
                if (!decision.allowed)
                    throw Error('Browser action denied or cancelled before dispatch; nothing was executed');
            }
            // Re-read authoritative policy after the user wait. No cached connection can authorize a stale policy.
            const latestPolicy = await this.readPolicy(), latestFacts = await this.deps.facts(parts);
            this.deps.assertCurrent(scope);
            if (digest !== browserActionDigest({ scope, parts, facts: latestFacts, userSource: browserActionDigest(this.deps.userMessages()), policyVersion: latestPolicy.configVersion, policyDigest: latestPolicy.policyDigest })) {
                if (requestId)
                    this.deps.settled?.(requestId, 'invalidated_before_dispatch');
                throw Error('Browser action or policy changed before dispatch; nothing was executed');
            }
            this.deps.assertCurrent(scope);
            await audit('dispatching');
            assertNotCancelled();
            this.deps.assertCurrent(scope);
            if (browserActionDigest(parts)!==auditBase.commandDigest || browserActionDigest(this.deps.userMessages()) !== userSource)
                throw new BrowserActionNotDispatched('Original user request changed before dispatch; nothing was executed');
            const controller = new AbortController(), parent = this.deps.signal?.();
            if (parent?.aborted)
                throw new BrowserActionNotDispatched('Browser action cancelled before dispatch; nothing was executed');
            const onAbort = () => controller.abort();
            parent?.addEventListener('abort', onAbort, { once: true });
            this.dispatches.add(controller);
            try {
                const result = await dispatch(latestFacts, { id: randomUUID(), issuedAt: Date.now(), expiresAt: Date.now() + 120000, scope, signal: controller.signal });
                await audit('dispatched');
                return result;
            }
            catch (e) {
                if (e instanceof BrowserActionNotDispatched) {
                    if (requestId)
                        this.deps.settled?.(requestId, 'invalidated_before_dispatch');
                    throw e;
                }
                if (requestId)
                    this.deps.settled?.(requestId, 'dispatched_outcome_unknown');
                throw Error('Browser action dispatched; outcome is unverified. Check the original result. Do not repeat the action.');
            }
            finally {
                parent?.removeEventListener('abort', onAbort);
                this.dispatches.delete(controller);
            }
        };
        const promise = run();
        this.operations.set(operationKey, promise);
        try {
            return await promise;
        }
        catch (e) {
            // Known pre-dispatch failures may be reconsidered with new authorization; unknown dispatches stay fenced.
            if (!String(e).includes('dispatched; outcome')) {
                this.operations.delete(operationKey);
                try {
                    await audit('not_dispatched', 'denied_cancelled_or_invalidated');
                }
                catch { }
            }
            else {
                try {
                    await audit('outcome_unverified', 'dispatch_result_unknown');
                }
                catch { }
            }
            throw e;
        }
        finally {
            if (requestId)
                this.deps.closed?.(requestId);
        }
    }
}
