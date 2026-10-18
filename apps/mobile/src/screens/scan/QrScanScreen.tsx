// Scan screen for QR login authorization (POL-15, prototype P10).
//
// Entry: Home 「扫码授权登录」 row — only reachable while signed in (AuthGate
// owns that guard for every route). Camera viewfinder with the ScanFrame
// overlay; a decoded payload is parsed by parseQrPayload, then POSTed to
// /api/auth/qr/scan (扫码登记 — marks this phone as the scanner and returns
// the requester card) before routing to the confirm page (/qr-confirm) with
// the requester param. A non-Polo payload or a scan failure (无票据 404 /
// 确认窗口关闭 410 / …) surfaces the shared alert machine instead. 相册识码
// 与手电筒是候选规则，本卡不做。

import { useCallback, useMemo, useRef } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeType } from 'expo-camera';
import { useRouter, useFocusEffect } from 'expo-router';

import { qrLoginApi } from '../../api/qrLogin';
import { ScanFrame } from '../../components/ScanFrame';
import { parseQrPayload } from '../../lib/parseQrPayload';
import { qrErrorToAlertCopy, qrInvalidPayloadCopy } from '../../lib/qrLoginUi';
import { colors, fontSize } from '../../theme/tokens';

export function QrScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();

  // A scan that already won the race navigates; the camera keeps emitting
  // events until the screen unmounts, so a lock prevents double-pushes and
  // re-handling while an alert is up.
  const handlingRef = useRef(false);

  const releaseLock = useCallback(() => {
    handlingRef.current = false;
  }, []);

  // Coming back from the confirm page (or a dismissed alert) must re-arm the
  // scanner — the lock only exists to stop duplicate handling in one burst.
  useFocusEffect(
    useCallback(() => {
      handlingRef.current = false;
      return undefined;
    }, []),
  );

  const goBack = useCallback(() => {
    releaseLock();
    if (router.canDismiss()) {
      router.dismiss();
    } else {
      router.back();
    }
  }, [releaseLock, router]);

  const showAlert = useCallback(
    ({ title, message }: { title: string; message: string }) => {
      Alert.alert(title, message, [
        { text: '重新扫码', style: 'default', onPress: releaseLock },
        { text: '返回', style: 'cancel', onPress: goBack },
      ], { cancelable: false, onDismiss: releaseLock });
    },
    [goBack, releaseLock],
  );

  const handleBarcode = useCallback(
    ({ data }: { data: string }) => {
      if (handlingRef.current) return;
      const payload = parseQrPayload(data);
      if (payload.kind !== 'valid') {
        handlingRef.current = true;
        showAlert(qrInvalidPayloadCopy());
        return;
      }
      handlingRef.current = true;
      // 扫码登记 first: the scan call marks this phone as the scanner and
      // returns the requester card (设备类型/ipMasked/发起时间) that the
      // confirm page renders — the card data is handed over as a JSON param
      // so the page never renders 「未知设备/—」 placeholders after a scan.
      // Failures (404 无票据 / 410 qr_confirm_window_expired / …) surface the
      // same alert machine; its dismissal re-arms the scanner via the lock.
      void qrLoginApi
        .scan({ qrId: payload.qrId, secret: payload.secret })
        .then((scanView) => {
          router.push({
            pathname: '/qr-confirm',
            params: {
              qrId: payload.qrId,
              secret: payload.secret,
              requester: JSON.stringify(scanView.requester),
            },
          });
        })
        .catch((error: unknown) => {
          showAlert(qrErrorToAlertCopy(error));
        });
    },
    [router, showAlert],
  );

  const barcodeScannerSettings = useMemo<{ barcodeTypes: BarcodeType[] }>(
    () => ({ barcodeTypes: ['qr'] }),
    [],
  );

  return (
    <View style={styles.screen}>
      {permission === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.white} />
        </View>
      ) : permission.granted ? (
        <>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={barcodeScannerSettings}
            onBarcodeScanned={handleBarcode}
          />
          <View style={styles.overlay}>
            <View style={styles.topBar}>
              <Pressable accessibilityRole="button" onPress={goBack} hitSlop={12}>
                <Text style={styles.backLabel}>‹ 返回</Text>
              </Pressable>
              <Text style={styles.title}>扫码授权登录</Text>
              <View style={styles.topBarSpacer} />
            </View>
            <View style={styles.viewfinder}>
              <ScanFrame size={248} cornerColor={colors.white} lineColor={colors.accent} />
            </View>
            <View style={styles.hintArea}>
              <Text style={styles.hint}>对准电脑或网页上的登录二维码</Text>
              <Text style={styles.hintSub}>扫码后需在本机再次确认，谨防他人冒用</Text>
            </View>
            <View style={styles.bottomArea}>
              <View style={styles.chip}>
                <Text style={styles.chipText}>仅已登录的手机可以授权新设备</Text>
              </View>
            </View>
          </View>
        </>
      ) : (
        <PermissionDenied
          canAskAgain={permission.canAskAgain}
          onRequest={() => void requestPermission()}
          onOpenSettings={() => void Linking.openSettings()}
          onBack={goBack}
        />
      )}
    </View>
  );
}

function PermissionDenied({
  canAskAgain,
  onRequest,
  onOpenSettings,
  onBack,
}: {
  canAskAgain: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
  onBack: () => void;
}) {
  return (
    <View style={[styles.center, styles.deniedGap]}>
      <Text style={styles.deniedTitle}>无法使用相机</Text>
      <Text style={styles.deniedMessage}>
        扫码授权需要使用相机。{'\n'}
        {canAskAgain ? '请在接下来的弹窗中允许相机权限。' : '相机权限已被拒绝，请前往系统设置开启。'}
      </Text>
      {canAskAgain ? (
        <Pressable accessibilityRole="button" onPress={onRequest} style={({ pressed }) => [styles.deniedButton, pressed && styles.pressed]}>
          <Text style={styles.deniedButtonLabel}>授权相机权限</Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" onPress={onOpenSettings} style={({ pressed }) => [styles.deniedButton, styles.deniedButtonGhost, pressed && styles.pressed]}>
        <Text style={styles.deniedButtonLabel}>去系统设置</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onBack} hitSlop={12}>
        <Text style={styles.deniedBack}>返回</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#111317',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    paddingHorizontal: 16,
  },
  backLabel: {
    color: colors.white,
    fontSize: 13.5,
    opacity: 0.85,
    width: 64,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
  },
  topBarSpacer: {
    width: 64,
  },
  viewfinder: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  hintArea: {
    alignItems: 'center',
    gap: 5,
    marginBottom: 24,
  },
  hint: {
    color: colors.white,
    fontSize: 13.5,
    textAlign: 'center',
  },
  hintSub: {
    color: colors.white,
    fontSize: 12,
    opacity: 0.65,
    textAlign: 'center',
  },
  bottomArea: {
    alignItems: 'center',
    paddingBottom: 28,
  },
  chip: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: {
    color: colors.white,
    fontSize: 12,
  },
  deniedGap: {
    gap: 14,
  },
  deniedTitle: {
    color: colors.white,
    fontSize: fontSize.title,
    fontWeight: '600',
  },
  deniedMessage: {
    color: colors.white,
    fontSize: fontSize.body,
    opacity: 0.75,
    textAlign: 'center',
    lineHeight: 22,
  },
  deniedButton: {
    minWidth: 200,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    paddingHorizontal: 20,
  },
  deniedButtonGhost: {
    backgroundColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  deniedButtonLabel: {
    color: colors.white,
    fontSize: fontSize.button,
    fontWeight: '500',
  },
  deniedBack: {
    color: colors.white,
    fontSize: fontSize.action,
    opacity: 0.7,
    marginTop: 2,
  },
  pressed: {
    opacity: 0.7,
  },
});
