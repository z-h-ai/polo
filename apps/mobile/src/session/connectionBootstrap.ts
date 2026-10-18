// Connection bootstrap (POL-18 wiring) — closes the POL-17 dependency note:
// the pairing flow's captured wsUrl and devicesApi.list()'s
// phoneDeviceId/macDeviceId must land in connectionTarget.set() at pairing
// success / device selection time; the connection manager lifecycle starts here.
//
// Two write points:
//   1. PairFlowScreen bind success — the QR scan captured wsUrl (manual code
//      entry has none → relay-only until the next scan, documented gap);
//      phoneDeviceId = the fresh bind row id, macDeviceId = the bound Mac.
//   2. Device list row tap / messages-tab restore — DeviceView rows carry
//      {id (phone), macDeviceId}; the QR wsUrl is not persisted on this card,
//      so an existing target for the same Mac KEEPS its wsUrl (never wiped).

import { connectionManager, connectionTarget } from '../conn/ConnectionManager';
import type { DeviceView } from '../api/devices';

export interface SelectionInput {
  phoneDeviceId: string;
  macDeviceId: string;
  /** wsUrl captured at scan time; null clears, undefined keeps the current. */
  wsUrl?: string | null;
}

function sameTarget(
  a: { phoneDeviceId: string; macDeviceId: string; wsUrl: string | null },
  b: { phoneDeviceId: string; macDeviceId: string; wsUrl: string | null },
): boolean {
  return (
    a.phoneDeviceId === b.phoneDeviceId &&
    a.macDeviceId === b.macDeviceId &&
    a.wsUrl === b.wsUrl
  );
}

/**
 * Writes the connection target and starts the manager. Re-selecting the same
 * target is a no-op (no reconnect churn). Clears any stale 安全态 by virtue of
 * manager.start() (authBlocked reset) — the session store clears its banner
 * when the next online status arrives.
 */
export function selectConnectionTarget(input: SelectionInput): void {
  const current = connectionTarget.get();
  const wsUrl = input.wsUrl !== undefined ? input.wsUrl : (current?.wsUrl ?? null);
  const next = {
    phoneDeviceId: input.phoneDeviceId,
    macDeviceId: input.macDeviceId,
    wsUrl,
  };
  if (current && sameTarget(current, next)) return;
  connectionTarget.set(next);
  connectionManager.start();
}

/** Device-row selection (device list tap / messages-tab restore). */
export function selectDeviceRow(device: DeviceView): void {
  selectConnectionTarget({
    phoneDeviceId: device.id,
    macDeviceId: device.macDeviceId,
    // The list has no QR context; keep a wsUrl already captured for this Mac.
    wsUrl: undefined,
  });
}

/** The target feeding the manager, if a device was selected. */
export function currentSelection(): { phoneDeviceId: string; macDeviceId: string; wsUrl: string | null } | null {
  return connectionTarget.get();
}
