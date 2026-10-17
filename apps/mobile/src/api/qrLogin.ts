// QR login endpoints for the phone side of the three-party confirm flow
// (POL-15; admin contract: src/app/api/auth/qr/{status,confirm}/route.ts +
// src/lib/qr-login/service.ts).
//
// Wire shapes (verified against polo-admin @ deb31d86):
//   GET  /api/auth/qr/status?qrId=...      (unauthenticated, IP rate-limited)
//        -> { qrId, status, expiresInSeconds, requester }
//   POST /api/auth/qr/confirm              (Bearer JWT required; userId is
//        taken from the token server-side — 反钓鱼 C3, the body never carries it)
//        body { qrId, secret, action: 'confirm' | 'reject' } -> same view shape
//
// status: 'pending' | 'scanned' | 'confirmed' | 'rejected' | 'expired' | 'consumed'
// requester: { clientType, ipMasked, userAgent } | null (null while pending).
//
// Error codes pass through verbatim as ApiError (client.ts contract): the UI
// layer maps them to copy — nothing is swallowed or translated here.

import { apiClient } from './client';
import type { ApiClient } from './client';

export const QR_TICKET_STATUSES = [
  'pending',
  'scanned',
  'confirmed',
  'rejected',
  'expired',
  'consumed',
] as const;

export type QrTicketStatus = (typeof QR_TICKET_STATUSES)[number];

/** Requester display info — 仅核对展示（P11），不参与授权决策。 */
export interface QrRequesterView {
  clientType: string;
  ipMasked: string | null;
  userAgent: string | null;
}

export interface QrStatusView {
  qrId: string;
  status: QrTicketStatus;
  /** Seconds until the ticket expires (admin TTL: 2 minutes). */
  expiresInSeconds: number;
  requester: QrRequesterView | null;
}

export type QrConfirmAction = 'confirm' | 'reject';

export interface QrLoginApi {
  /** Polls ticket state; also the source of the confirm page's requester card. */
  getStatus(qrId: string): Promise<QrStatusView>;
  /** 确认登录 — authorizes the waiting device with this phone's JWT. */
  confirm(input: { qrId: string; secret: string }): Promise<QrStatusView>;
  /** 不是我，拒绝 — invalidates the ticket. */
  reject(input: { qrId: string; secret: string }): Promise<QrStatusView>;
}

interface StatusViewWire {
  qrId?: unknown;
  status?: unknown;
  expiresInSeconds?: unknown;
  requester?: {
    clientType?: unknown;
    ipMasked?: unknown;
    userAgent?: unknown;
  } | null;
}

function toStatusView(data: StatusViewWire): QrStatusView {
  if (
    typeof data.qrId !== 'string' ||
    typeof data.status !== 'string' ||
    !QR_TICKET_STATUSES.includes(data.status as QrTicketStatus)
  ) {
    throw new Error('Admin response is missing qr status fields');
  }

  const requester = data.requester;
  return {
    qrId: data.qrId,
    status: data.status as QrTicketStatus,
    expiresInSeconds: typeof data.expiresInSeconds === 'number' ? data.expiresInSeconds : 0,
    requester:
      requester && typeof requester === 'object'
        ? {
            clientType: typeof requester.clientType === 'string' ? requester.clientType : '',
            ipMasked: typeof requester.ipMasked === 'string' ? requester.ipMasked : null,
            userAgent: typeof requester.userAgent === 'string' ? requester.userAgent : null,
          }
        : null,
  };
}

export function createQrLoginApi(
  client: Pick<ApiClient, 'request' | 'post'> = apiClient,
): QrLoginApi {
  return {
    // Status is an unauthenticated endpoint on admin (no requireAuth) — keep
    // the Authorization header off so a mid-session token hiccup can never
    // fail a display-only call.
    async getStatus(qrId) {
      const data = await client.request<StatusViewWire>(
        `/api/auth/qr/status?qrId=${encodeURIComponent(qrId)}`,
        { auth: false },
      );
      return toStatusView(data);
    },

    async confirm({ qrId, secret }) {
      const data = await client.post<StatusViewWire>('/api/auth/qr/confirm', {
        qrId,
        secret,
        action: 'confirm' satisfies QrConfirmAction,
      });
      return toStatusView(data);
    },

    async reject({ qrId, secret }) {
      const data = await client.post<StatusViewWire>('/api/auth/qr/confirm', {
        qrId,
        secret,
        action: 'reject' satisfies QrConfirmAction,
      });
      return toStatusView(data);
    },
  };
}

/** App-wide singleton on the shared api client (attaches the phone JWT). */
export const qrLoginApi = createQrLoginApi();
