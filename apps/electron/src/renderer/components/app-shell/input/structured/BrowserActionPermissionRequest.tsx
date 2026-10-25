import { useTranslation } from 'react-i18next';
import { ShieldAlert, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PermissionRequest as PermissionRequestType } from '../../../../../shared/types';
import type { PermissionResponse } from './types';
interface PermissionRequestProps {
    request: PermissionRequestType;
    onResponse: (response: PermissionResponse) => void;
    unstyled?: boolean;
}
/** Exact business authorization; a broad tool grant cannot approve this action. */
export function BrowserActionPermissionRequest({ request, onResponse, unstyled = false }: PermissionRequestProps) {
    const { t } = useTranslation();
    const action = request.browserAction ?? { phase: 'invalidated_before_dispatch' as const, fields: [], actionDigest: '' };
    const labelKey: Record<string, string> = { '网站': 'website', '操作': 'operation', '订单': 'order', '对象': 'object', '收款方': 'payee', '接收人': 'recipient', '金额': 'amount', '币种': 'currency', '消息内容': 'content', '目标': 'target', '当前状态': 'status' };
    const operationKey: Record<string, string> = { '支付订单': 'pay', '发送消息': 'send', '删除': 'delete', '保存或提交': 'save', '页面操作': 'ordinary', '待核对操作': 'unknown' };
    const outcomeUnknown = action.phase === 'dispatched_outcome_unknown';
    const awaiting = action.phase === 'awaiting_authorization';
    const handleAllow = () => {
        onResponse({ type: 'permission', allowed: true, alwaysAllow: false, browserActionDigest: action.actionDigest, browserActionPhase: action.phase });
    };
    const handleDeny = () => {
        onResponse({ type: 'permission', allowed: false, alwaysAllow: false, browserActionDigest: action.actionDigest, browserActionPhase: action.phase });
    };
    return (<div className={cn('overflow-hidden h-full flex flex-col bg-info/5', unstyled
            ? 'border-0'
            : 'border border-info/30 rounded-[8px] shadow-middle')} data-tutorial="permission-banner">
      {/* Content - grows to fill available space and scrolls before actions disappear */}
      <div className="p-4 space-y-3 flex-1 min-h-0 flex flex-col overflow-y-auto">
        <div className="space-y-2 pb-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <ShieldAlert className="h-3.5 w-3.5 text-info"/>
            <span>{t(outcomeUnknown ? 'browserAuthorization.outcomeTitle' : 'browserAuthorization.title')}</span>
          </div>
          <div className="text-xs leading-[18px] text-muted-foreground">
            {t(outcomeUnknown ? 'browserAuthorization.outcomeDescription' : awaiting ? 'browserAuthorization.description' : 'browserAuthorization.invalidatedDescription')}
          </div>
          <dl className="space-y-2 text-xs leading-[18px]">
            {action.fields.map(([label, value]) => <div key={label} className="flex flex-col gap-1"><dt className="text-muted-foreground">{labelKey[label] ? t(`browserAuthorization.field.${labelKey[label]}`) : label}</dt><dd className="font-medium break-words whitespace-pre-wrap">{label === '操作' && operationKey[value] ? t(`browserAuthorization.operation.${operationKey[value]}`) : value}</dd></div>)}
          </dl>

        </div>


      </div>

      {/* Action buttons */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-t border-border/50">
        {!outcomeUnknown && (<Button size="sm" variant="default" className="h-7 gap-1.5" onClick={handleAllow} disabled={!awaiting} data-tutorial="permission-allow-button">
          <Check className="h-3.5 w-3.5"/>
          {t('browserAuthorization.allowOnce')}
        </Button>)}

        <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-destructive hover:text-destructive border border-dashed border-destructive/50 hover:bg-destructive/10 hover:border-destructive/70 active:bg-destructive/20" onClick={handleDeny}>
          <X className="h-3.5 w-3.5"/>
          {t(awaiting ? 'browserAuthorization.deny' : 'browserAuthorization.close')}
        </Button>

        {/* Tip text */}
        <span className="min-w-0 flex-1 basis-full text-[10px] text-muted-foreground sm:basis-auto sm:text-right">
          {t(outcomeUnknown ? 'browserAuthorization.outcomeNotice' : awaiting ? 'browserAuthorization.notice' : 'browserAuthorization.invalidatedNotice')}
        </span>
      </div>
    </div>);
}
