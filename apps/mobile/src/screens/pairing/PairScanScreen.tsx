// P03 配对扫码屏 (POL-241).
//
// Viewfinder over the camera with the shared ScanFrame overlay; a decoded
// payload goes through parsePairingPayload (D02: {code, wsUrl} JSON, wsUrl is
// a LAN hint only — never an authorization input). A valid code is handed to
// onCodeScanned; anything else (including the POL-240 qr-LOGIN payloads — a
// login QR must not be consumed as pairing) lands on the P03/P10-style alert
// layer, 收口在本屏. 底部「手动输入配对码」备选入口 (P03)；页头提示「配对码
// 5 分钟内有效 · 一次性使用」。相册识码与手电筒是候选规则，本卡不做。

import { useCallback, useMemo, useRef } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeType } from 'expo-camera';
import { useRouter, useFocusEffect } from 'expo-router';

import { ScanFrame } from '../../components/ScanFrame';
import { parsePairingPayload } from '../../lib/pairingPayload';
import { colors, fontSize } from '../../theme/tokens';

export function PairScanScreen({
  onCodeScanned,
  onManualEntry,
}: {
  onCodeScanned: (code: string, wsUrl: string | null) => void;
  onManualEntry: () => void;
}) {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();

  // Same lock discipline as QrScanScreen (POL-240): the camera keeps emitting
  // events until unmount; the lock prevents double-handling while navigating
  // or while an alert is up. Re-armed on focus (returning from the flow).
  const handlingRef = useRef(false);

  const releaseLock = useCallback(() => {
    handlingRef.current = false;
  }, []);

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
      const payload = parsePairingPayload(data);
      if (payload.kind !== 'valid') {
        handlingRef.current = true;
        showAlert(pairingInvalidPayloadCopy(payload.reason));
        return;
      }
      handlingRef.current = true;
      onCodeScanned(payload.code, payload.wsUrl);
    },
    [onCodeScanned, showAlert],
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
              <Text style={styles.title}>添加电脑</Text>
              <View style={styles.topBarSpacer} />
            </View>
            <View style={styles.viewfinder}>
              <ScanFrame size={248} cornerColor={colors.white} lineColor={colors.accent} />
            </View>
            <View style={styles.hintArea}>
              <Text style={styles.hint}>对准 Mac 上 Polo 设置页的配对二维码</Text>
              <Text style={styles.hintSub}>配对码 5 分钟内有效 · 一次性使用</Text>
            </View>
            <View style={styles.bottomArea}>
              <Pressable
                accessibilityRole="button"
                onPress={onManualEntry}
                style={({ pressed }) => [styles.manualLink, pressed && styles.pressed]}
              >
                <Text style={styles.manualLinkText}>手动输入配对码</Text>
              </Pressable>
            </View>
          </View>
        </>
      ) : (
        <PermissionDenied
          canAskAgain={permission.canAskAgain}
          onRequest={() => void requestPermission()}
          onOpenSettings={() => void Linking.openSettings()}
          onBack={goBack}
          onManualEntry={onManualEntry}
        />
      )}
    </View>
  );
}

/** P03/P10 弹层文案：无效/误扫（含误扫登录码）统一收口. */
export function pairingInvalidPayloadCopy(reason: string): { title: string; message: string } {
  if (reason === 'missing_code' || reason === 'bad_code') {
    return {
      title: '不是有效的配对二维码',
      message: '二维码中没有读到 6 位配对码，请在 Mac「设置 → 手机连接」页重新出示',
    };
  }
  return {
    title: '这不是 Polo 配对二维码',
    message: '请扫描 Mac 上 Polo 设置页「手机连接」出示的配对二维码',
  };
}

function PermissionDenied({
  canAskAgain,
  onRequest,
  onOpenSettings,
  onBack,
  onManualEntry,
}: {
  canAskAgain: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
  onBack: () => void;
  onManualEntry: () => void;
}) {
  return (
    <View style={[styles.center, styles.deniedGap]}>
      <Text style={styles.deniedTitle}>无法使用相机</Text>
      <Text style={styles.deniedMessage}>
        扫码配对需要使用相机。{'\n'}
        {canAskAgain ? '请在接下来的弹窗中允许相机权限。' : '相机权限已被拒绝，请前往系统设置开启，或使用手动输码。'}
      </Text>
      {canAskAgain ? (
        <Pressable accessibilityRole="button" onPress={onRequest} style={({ pressed }) => [styles.deniedButton, pressed && styles.pressed]}>
          <Text style={styles.deniedButtonLabel}>授权相机权限</Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" onPress={onOpenSettings} style={({ pressed }) => [styles.deniedButton, styles.deniedButtonGhost, pressed && styles.pressed]}>
        <Text style={styles.deniedButtonLabel}>去系统设置</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onManualEntry} hitSlop={8}>
        <Text style={styles.deniedManual}>手动输入配对码</Text>
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
    paddingBottom: 30,
  },
  manualLink: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  manualLinkText: {
    color: colors.accent,
    fontSize: 13,
  },
  deniedGap: {
    gap: 14,
    backgroundColor: colors.background,
  },
  deniedTitle: {
    color: colors.foreground,
    fontSize: fontSize.title,
    fontWeight: '600',
  },
  deniedMessage: {
    color: colors.fg50,
    fontSize: fontSize.body,
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
    borderColor: colors.buttonBorder,
  },
  deniedButtonLabel: {
    color: colors.white,
    fontSize: fontSize.button,
    fontWeight: '500',
  },
  deniedManual: {
    color: colors.accent,
    fontSize: 13,
  },
  deniedBack: {
    color: colors.fg50,
    fontSize: fontSize.action,
    marginTop: 2,
  },
  pressed: {
    opacity: 0.7,
  },
});
