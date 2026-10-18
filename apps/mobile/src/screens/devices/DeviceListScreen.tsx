// 设备 Tab 实体屏 (POL-16, prototype P02).
//
// Two shapes like P02:
//   - 列表态: one DeviceStatusCard per bound Mac (three-state badge via
//     lastSeenAt inference — 在线·经云中转 / 离线·最近在线…; the LAN-direct
//     variant and real connection state land with the POL-17 connection
//     manager, noted in the footer), header 添加 entry -> /pair, row tap ->
//     /device-manage (P12), footer dual-channel + privacy lines.
//   - 空态: 还没有绑定电脑 guidance + 扫码添加电脑 -> /pair + 手动输入配对码
//     -> /pair?mode=manual.
// List source: admin GET /api/devices/list on every focus (admin is the only
// binding source of truth; no local cache on this card).

import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';

import { devicesApi } from '../../api/devices';
import type { DeviceView } from '../../api/devices';
import { NetworkError } from '../../api/client';
import { DeviceStatusCard } from '../../components/DeviceStatusCard';
import { LargeTitle } from '../../components/LargeTitle';
import { TabIcon } from '../../components/TabIcons';
import { selectDeviceRow } from '../../session/connectionBootstrap';
import { deviceListShape, DEVICE_EMPTY_COPY, DEVICE_LIST_FOOTER_LINES } from '../../lib/devicesUi';
import { colors, fontSize } from '../../theme/tokens';

export const DEVICES_TITLE = '我的电脑';

export function DeviceListScreen() {
  const router = useRouter();
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // State per focus tick; captured by the focus callback so a re-focus
  // always starts a fresh fetch even if the previous one never resolved.
  const [reloadTick, setReloadTick] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      setLoadError(null);
      devicesApi
        .list()
        .then((rows) => {
          if (alive) setDevices(rows);
        })
        .catch((error: unknown) => {
          if (!alive) return;
          // Keep whatever list the previous focus produced (stale display +
          // hint), or fall through to the error block when there is none.
          setDevices((prev) => prev ?? []);
          setLoadError(
            error instanceof NetworkError ? '网络异常，暂时无法获取设备列表' : '设备列表加载失败，请下拉重试',
          );
        });
      return () => {
        alive = false;
      };
    }, [reloadTick]),
  );

  const retry = useCallback(() => setReloadTick((tick) => tick + 1), []);

  const goPair = useCallback(() => router.push('/pair'), [router]);
  const goPairManual = useCallback(() => router.push({ pathname: '/pair', params: { mode: 'manual' } }), [router]);
  const goManage = useCallback(() => router.push('/device-manage'), [router]);

  const loading = devices === null;
  const shape = devices === null ? null : deviceListShape(devices, Date.now());

  return (
    <View style={styles.screen}>
      <View style={styles.headerWrap}>
        <LargeTitle title={DEVICES_TITLE} />
        {!loading && shape?.shape === 'list' ? (
          <Pressable accessibilityRole="button" onPress={goPair} hitSlop={10} style={styles.addAction}>
            <Text style={styles.addLabel}>＋ 添加</Text>
          </Pressable>
        ) : null}
        {!loading && shape?.shape === 'list' ? (
          <Pressable accessibilityRole="button" onPress={goManage} hitSlop={10} style={styles.manageAction}>
            <Text style={styles.manageLabel}>管理</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={shape?.shape === 'empty' ? styles.emptyContent : styles.content}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : loadError && shape?.shape === 'empty' ? (
          <LoadError message={loadError} onRetry={retry} />
        ) : shape?.shape === 'empty' ? (
          <EmptyState onScan={goPair} onManual={goPairManual} />
        ) : shape?.shape === 'list' ? (
          <>
            {loadError ? (
              <Text style={styles.staleHint}>{loadError}，显示的是最近一次结果</Text>
            ) : null}
            {shape.cards.map((card, index) => (
              <DeviceStatusCard
                key={card.key}
                card={card}
                onPress={() => {
                  // POL-18 wiring: tapping a device card selects it as the
                  // connection target (phoneDeviceId/macDeviceId from the
                  // admin row; a previously captured wsUrl is kept) before
                  // the P02 manage navigation.
                  const row = devices[index];
                  if (row) selectDeviceRow(row);
                  goManage();
                }}
              />
            ))}
            <View style={styles.footer}>
              {DEVICE_LIST_FOOTER_LINES.map((line) => (
                <Text key={line} style={styles.footerLine}>
                  {line}
                </Text>
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function EmptyState({ onScan, onManual }: { onScan: () => void; onManual: () => void }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyGlyph}>
        <TabIcon name="devices" color={colors.fg40} size={44} />
      </View>
      <Text style={styles.emptyTitle}>{DEVICE_EMPTY_COPY.title}</Text>
      <Text style={styles.emptyMessage}>{DEVICE_EMPTY_COPY.message}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onScan}
        style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
      >
        <View style={styles.primaryInner}>
          <TabIcon name="devices" color={colors.white} size={16} />
          <Text style={styles.primaryLabel}>{DEVICE_EMPTY_COPY.scan}</Text>
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onManual} hitSlop={8}>
        <Text style={styles.manualLink}>{DEVICE_EMPTY_COPY.manual}</Text>
      </Pressable>
    </View>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.loadError}>
      <Text style={styles.loadErrorText}>{message}</Text>
      <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={8}>
        <Text style={styles.retryLink}>重试</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  headerWrap: {
    paddingHorizontal: 16,
  },
  addAction: {
    position: 'absolute',
    right: 16,
    bottom: 8,
    minHeight: 32,
    justifyContent: 'center',
  },
  addLabel: {
    color: colors.accent,
    fontSize: 13.5,
    fontWeight: '500',
  },
  manageAction: {
    position: 'absolute',
    right: 74,
    bottom: 8,
    minHeight: 32,
    justifyContent: 'center',
  },
  manageLabel: {
    color: colors.fg60,
    fontSize: 13.5,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingTop: 8,
    gap: 10,
  },
  emptyContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 36,
    gap: 12,
  },
  loadingRow: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  staleHint: {
    fontSize: 11.5,
    textAlign: 'center',
    color: colors.info,
  },
  footer: {
    marginTop: 6,
    gap: 4,
  },
  footerLine: {
    fontSize: 11.5,
    lineHeight: 19,
    textAlign: 'center',
    color: colors.fg40,
  },
  empty: {
    alignItems: 'center',
    gap: 12,
    width: '100%',
  },
  emptyGlyph: {
    width: 84,
    height: 84,
    borderRadius: 24,
    backgroundColor: colors.fieldBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },
  emptyMessage: {
    fontSize: 12.5,
    lineHeight: 22,
    textAlign: 'center',
    color: colors.fg50,
  },
  primary: {
    width: '100%',
    height: 46,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  primaryInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primaryLabel: {
    color: colors.white,
    fontSize: fontSize.button,
    fontWeight: '600',
  },
  manualLink: {
    color: colors.accent,
    fontSize: 13,
  },
  loadError: {
    alignSelf: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 32,
  },
  loadErrorText: {
    fontSize: 13,
    color: colors.fg50,
  },
  retryLink: {
    color: colors.accent,
    fontSize: 13.5,
    fontWeight: '500',
  },
  pressed: {
    opacity: 0.8,
  },
});
