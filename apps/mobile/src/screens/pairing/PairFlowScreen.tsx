// Pairing flow container (POL-16) — the /pair route body.
//
// State machine over the P03/P04 prototype frames:
//   scan    -> camera + ScanFrame; a decoded D02 payload moves to confirm
//   manual  -> 6-digit entry; submit binds straight away (P03 第 2 屏)
//   confirm -> info card + countdown; 确认绑定 calls admin bind (P04 第 1 屏)
//   success -> 「绑定成功」 + 去发消息 / 返回设备列表 (P04 第 2 屏)
//   limit   -> device_bind_limit_reached 整屏错误态 (P04 第 3 屏)
// The bind call is owned here so both entries share it: name/platform are
// this phone's self-report (admin deviceBindSchema), pushToken stays unset
// until P3. Bind errors other than the limit surface per entry (manual ->
// P03 errbar, confirm -> alert) with the copy from pairingUi; the limit
// error switches to the dedicated screen with 前往设备管理.

import { useCallback, useState } from 'react';
import { Alert, Platform } from 'react-native';
import Constants from 'expo-constants';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ApiError, NetworkError } from '../../api/client';
import { devicesApi } from '../../api/devices';
import type { DevicePlatform } from '../../api/devices';
import {
  isBindLimitError,
  pairingCodeDeadline,
  pairingErrorBarCopy,
} from '../../lib/pairingUi';
import { PairConfirmScreen, PairLimitScreen, PairSuccessScreen } from './PairConfirmScreen';
import { PairManualScreen } from './PairManualScreen';
import { PairScanScreen } from './PairScanScreen';

type FlowState =
  | { step: 'scan' }
  | { step: 'manual' }
  | { step: 'confirm'; code: string; wsUrl: string | null; deadlineMs: number; observedAtMs: number }
  | { step: 'success'; reused: boolean }
  | { step: 'limit' };

/** This phone's self-report name for the Device row (P12 本机 style). */
export function phoneDisplayName(): string {
  const deviceName = (Constants as { deviceName?: string | null }).deviceName;
  const trimmed = typeof deviceName === 'string' ? deviceName.trim() : '';
  if (trimmed) return trimmed.slice(0, 128);
  return Platform.OS === 'android' ? 'Android 手机' : 'iPhone';
}

/** Admin deviceBindSchema platform enum ('ios' | 'android'). */
function devicePlatform(): DevicePlatform {
  return Platform.OS === 'android' ? 'android' : 'ios';
}

export function PairFlowScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();

  const [state, setState] = useState<FlowState>(
    params.mode === 'manual' ? { step: 'manual' } : { step: 'scan' },
  );
  const [busy, setBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  const goBack = useCallback(() => {
    if (router.canDismiss()) router.dismiss();
    else router.back();
  }, [router]);

  const handleScanned = useCallback((code: string, wsUrl: string | null) => {
    setManualError(null);
    const observedAtMs = Date.now();
    setState({ step: 'confirm', code, wsUrl, deadlineMs: pairingCodeDeadline(observedAtMs), observedAtMs });
  }, []);

  const showManual = useCallback(() => {
    setManualError(null);
    setState({ step: 'manual' });
  }, []);

  const backToScan = useCallback(() => {
    setManualError(null);
    setState({ step: 'scan' });
  }, []);

  const bind = useCallback(async (code: string, fromConfirm: boolean) => {
    if (busy) return;
    setBusy(true);
    setManualError(null);
    try {
      const result = await devicesApi.bind({
        code,
        name: phoneDisplayName(),
        platform: devicePlatform(),
      });
      setState({ step: 'success', reused: result.reused });
    } catch (error) {
      if (isBindLimitError(error)) {
        setState({ step: 'limit' });
        return;
      }
      const copy = pairingErrorBarCopy(error);
      if (fromConfirm) {
        // P04 defines no inline error on the confirm frame — surface the
        // mapped copy as an alert and keep the confirm context.
        const title = error instanceof NetworkError ? '网络连接失败' : '绑定失败';
        Alert.alert(title, copy, [{ text: '好', style: 'default' }], { cancelable: true });
      } else {
        setManualError(copy);
      }
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const goMessages = useCallback(() => {
    router.dismissAll();
    router.navigate('/');
  }, [router]);

  const goDeviceList = useCallback(() => {
    router.dismissAll();
    router.navigate('/devices');
  }, [router]);

  const goDeviceManage = useCallback(() => {
    router.dismissAll();
    router.navigate('/device-manage');
  }, [router]);

  switch (state.step) {
    case 'scan':
      return (
        <PairScanScreen onCodeScanned={handleScanned} onManualEntry={showManual} />
      );
    case 'manual':
      return (
        <PairManualScreen
          error={manualError}
          busy={busy}
          onSubmit={(code) => void bind(code, false)}
          onBack={backToScan}
        />
      );
    case 'confirm':
      return (
        <PairConfirmScreen
          data={{
            code: state.code,
            wsUrl: state.wsUrl,
            deadlineMs: state.deadlineMs,
            nowMs: state.observedAtMs,
          }}
          busy={busy}
          onConfirm={() => void bind(state.code, true)}
          onCancel={goBack}
        />
      );
    case 'success':
      return (
        <PairSuccessScreen
          reused={state.reused}
          onGoMessages={goMessages}
          onBackToList={goDeviceList}
        />
      );
    case 'limit':
      return <PairLimitScreen onOpenManage={goDeviceManage} onBack={backToScan} />;
  }
}
