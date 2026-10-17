// P12 设备管理屏 (POL-16).
//
// Three sections per the prototype frame:
//   本机: this phone (device display name + masked login phone + 当前设备 chip)
//   已绑定的电脑（N）: one row per active binding — status + 绑定于 date, each
//     with a 解绑 action that opens UnbindConfirmSheet; confirming calls
//     admin revoke (owner-scoped, idempotent) and refreshes the list —
//     admin is the only binding source of truth, no optimistic removal.
//   说明: the management-boundary block (5-phone cap + 60s disconnect window,
//     web-session guidance pointing at polo-admin 账号安全, unknown-device
//     advice).
// This phone's binding rows are NOT marked specially: admin list rows are the
// phone↔Mac bindings of this user; the 本机 section is informational only.

import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import Constants from 'expo-constants';

import { ApiError, NetworkError } from '../../api/client';
import { devicesApi } from '../../api/devices';
import type { DeviceView } from '../../api/devices';
import { UnbindConfirmSheet } from '../../components/UnbindConfirmSheet';
import { TabIcon } from '../../components/TabIcons';
import { useSessionStore } from '../../auth/session';
import { boundAtLabel } from '../../lib/deviceStatus';
import { macDisplayName, manageSectionTitles, MANAGE_NOTE_LINES, maskPhone } from '../../lib/devicesUi';
import { phoneDisplayName } from '../pairing/PairFlowScreen';
import { colors } from '../../theme/tokens';

export function DeviceManageScreen() {
  const router = useRouter();
  const user = useSessionStore((state) => state.user);

  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const [sheetTarget, setSheetTarget] = useState<DeviceView | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    setLoadError(null);
    devicesApi
      .list()
      .then((rows) => {
        if (alive) setDevices(rows);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setDevices((prev) => prev ?? []);
        setLoadError(
          error instanceof NetworkError ? '网络异常，暂时无法获取设备列表' : '设备列表加载失败',
        );
      });
    return () => {
      alive = false;
    };
  }, []);

  // Refresh on every focus AND after each revoke (解绑后列表刷新): the
  // reloadTick dep re-runs the focus effect when refresh() bumps it.
  useFocusEffect(
    useCallback(() => {
      return load();
    }, [load, reloadTick]),
  );

  const refresh = useCallback(() => setReloadTick((tick) => tick + 1), []);

  const confirmRevoke = useCallback(async () => {
    const target = sheetTarget;
    if (!target || revoking) return;
    setRevoking(true);
    try {
      await devicesApi.revoke({ deviceId: target.id });
      setSheetTarget(null);
      refresh();
    } catch (error) {
      setSheetTarget(null);
      Alert.alert('解绑失败', revokeErrorCopy(error), [
        { text: '好', style: 'default' },
      ], { cancelable: true });
    } finally {
      setRevoking(false);
    }
  }, [refresh, revoking, sheetTarget]);

  const goBack = useCallback(() => {
    if (router.canDismiss()) router.dismiss();
    else router.back();
  }, [router]);

  const sections = manageSectionTitles(devices?.length ?? 0);

  return (
    <View style={styles.screen}>
      <View style={styles.navBar}>
        <Pressable accessibilityRole="button" onPress={goBack} hitSlop={12}>
          <Text style={styles.back}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.title}>设备管理</Text>
        <View style={styles.navSpacer} />
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.sectionTitle}>{sections.mine}</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.avatar}>
              <TabIcon name="profile" color={colors.accentDeep} size={20} />
            </View>
            <View style={styles.texts}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {phoneDisplayName()}
              </Text>
              <Text style={styles.rowSub}>
                {user?.phone ? `${maskPhone(user.phone)} · 最近活跃 刚刚` : '当前登录设备'}
              </Text>
            </View>
            <View style={styles.currentChip}>
              <Text style={styles.currentChipText}>当前设备</Text>
            </View>
          </View>
        </View>

        <Text style={styles.sectionTitle}>{sections.bound}</Text>
        {devices === null ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : devices.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.emptyRow}>
              {loadError ?? '还没有绑定电脑，可在「设备」Tab 扫码添加'}
            </Text>
          </View>
        ) : (
          <View style={styles.card}>
            {devices.map((device) => (
              <View key={device.id} style={styles.row}>
                <View style={styles.avatar}>
                  <TabIcon name="devices" color={colors.accentDeep} size={20} />
                </View>
                <View style={styles.texts}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {macDisplayName(device)}
                  </Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {boundAtLabel(device)}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setSheetTarget(device)}
                  hitSlop={10}
                  style={({ pressed }) => [styles.unbind, pressed && styles.pressed]}
                >
                  <Text style={styles.unbindText}>解绑</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}

        <Text style={styles.sectionTitle}>说明</Text>
        <View style={styles.card}>
          {MANAGE_NOTE_LINES.map((line) => (
            <Text key={line} style={styles.noteLine}>
              · {line}
            </Text>
          ))}
        </View>
      </ScrollView>

      <UnbindConfirmSheet
        visible={sheetTarget !== null}
        targetName={sheetTarget ? macDisplayName(sheetTarget) : ''}
        busy={revoking}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => setSheetTarget(null)}
      />
    </View>
  );
}

function revokeErrorCopy(error: unknown): string {
  if (error instanceof NetworkError) return '网络异常，解绑未完成，请稍后重试';
  if (error instanceof ApiError) {
    if (error.errorCode === 'not_found') return '该绑定已被移除，列表已按最新状态处理';
    return `解绑失败（${error.errorCode}），请稍后重试`;
  }
  return '解绑失败，请稍后重试';
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: {
    width: 64,
    color: colors.foreground,
    fontSize: 13.5,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: colors.foreground,
    fontSize: 15,
    fontWeight: '600',
  },
  navSpacer: {
    width: 64,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingBottom: 20,
  },
  sectionTitle: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 8,
    fontSize: 12,
    fontWeight: '600',
    color: colors.fg60,
  },
  card: {
    marginHorizontal: 16,
    backgroundColor: colors.white,
    borderRadius: 14,
    paddingVertical: 4,
    paddingHorizontal: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 60,
    paddingVertical: 8,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  texts: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.foreground,
  },
  rowSub: {
    fontSize: 12,
    color: colors.fg50,
  },
  currentChip: {
    height: 22,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  currentChipText: {
    fontSize: 10.5,
    color: colors.accentDeep,
  },
  unbind: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  unbindText: {
    color: colors.destructive,
    fontSize: 13.5,
    fontWeight: '500',
  },
  loadingRow: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  emptyRow: {
    paddingVertical: 16,
    fontSize: 12.5,
    lineHeight: 20,
    color: colors.fg50,
  },
  noteLine: {
    fontSize: 12.5,
    lineHeight: 24,
    color: colors.fg60,
    paddingVertical: 4,
  },
  pressed: {
    opacity: 0.6,
  },
});
