// 我的 Tab (POL-19, prototype P13).
//
// P13 blocks, in order: account card (avatar + masked phone + user id), the
// voice & credits card (static balance placeholder + greyed-out 充值 chip +
// 积分规则 entry opening the half-sheet explainer with its four blocks), the
// read-only 识别方式 row (P-R1-01 option B: no switch control), the account
// card rows (扫码授权登录 migrated from the old HomeScreen, 账号安全 external
// browser link, 设备管理 -> devices tab, version row), then 退出登录.
// 充值 flow and live credits data are NOT this card (M2-5).

import { useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { create } from 'zustand';
import Constants from 'expo-constants';

import { useSessionStore } from '../../auth/session';
import { avatarInitials, maskPhone } from '../../lib/profileUi';
import { LargeTitle } from '../../components/LargeTitle';
import { TabIcon } from '../../components/TabIcons';
import { colors, fontSize } from '../../theme/tokens';
import { PROTOCOL_VERSION } from '@polo-ai/shared/protocol';

export const PROFILE_TITLE = '我的';
export const VOICE_SECTION_TITLE = '语音与积分';
export const ACCOUNT_SECTION_TITLE = '账号';
export const BALANCE_LABEL = '12,400 积分';
export const MONTHLY_USAGE_LABEL = '本月语音已用 312 积分（约 26 分钟）';
export const RECHARGE_LABEL = '充值';
export const CREDITS_RULES_LABEL = '积分规则';
export const RECOGNITION_TITLE = '识别方式';
export const RECOGNITION_SUB = '自动选择 · 边说边出字优先（供应商由 Polo 服务端配置）';
export const SCAN_ENTRY_TITLE = '扫码授权登录';
export const SCAN_ENTRY_SUB = '扫电脑或网页上的二维码，授权其登录';
export const SECURITY_TITLE = '账号安全';
export const SECURITY_SUB = '登录设备 / 改密 · 网页端管理';
export const SECURITY_URL = 'https://www.z-h-ai.com';
export const DEVICES_ROW_TITLE = '设备管理';
export const DEVICES_ROW_SUB = '绑定与解绑 · 见「设备」Tab';
export const SIGN_OUT_LABEL = '退出登录';
export const CREDITS_SHEET_TITLE = '语音积分说明';

/** Local modal visibility for the P13 explainer (no cross-tab state needed). */
interface CreditsSheetState {
  open: boolean;
  setOpen(open: boolean): void;
}
const useCreditsSheetStore = create<CreditsSheetState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function ProfileTab() {
  const router = useRouter();
  const user = useSessionStore((state) => state.user);
  const signOut = useSessionStore((state) => state.signOut);
  // Local busy flag: the shared status machine never enters 'authenticating'
  // during signOut, so the label is driven here (same as the old HomeScreen).
  const [signingOut, setSigningOut] = useState(false);
  const version = Constants.expoConfig?.version ?? '-';

  const onPressSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut(); // AuthGate routes back to /login on the status flip.
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <View style={styles.screen}>
      <LargeTitle title={PROFILE_TITLE} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <AccountCard user={user} />
        <SectionTitle label={VOICE_SECTION_TITLE} />
        <VoiceCreditsCard />
        <SectionTitle label={ACCOUNT_SECTION_TITLE} />
        <View style={styles.card}>
          <EntryRow
            glyph="scan"
            title={SCAN_ENTRY_TITLE}
            sub={SCAN_ENTRY_SUB}
            onPress={() => router.push('/scan-qr')}
          />
          <EntryRow
            glyph="shield"
            title={SECURITY_TITLE}
            sub={SECURITY_SUB}
            onPress={() => {
              void Linking.openURL(SECURITY_URL).catch(() => {
                // No browser available (e.g. simulator quirk); non-blocking.
              });
            }}
          />
          <EntryRow
            glyph="devices"
            title={DEVICES_ROW_TITLE}
            sub={DEVICES_ROW_SUB}
            onPress={() => router.push('/(tabs)/devices')}
            last
          />
        </View>
        <Text style={styles.versionRow}>
          Polo 手机版 v{version} · protocol v{PROTOCOL_VERSION}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: signingOut }}
          disabled={signingOut}
          onPress={() => void onPressSignOut()}
          style={({ pressed }) => [styles.signOut, (pressed || signingOut) && styles.pressed]}
        >
          <Text style={styles.signOutText}>{signingOut ? '退出中…' : SIGN_OUT_LABEL}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function AccountCard({
  user,
}: {
  user: { id: string; phone: string; username?: string; displayName?: string | null } | null;
}) {
  return (
    <View style={[styles.card, styles.accountCard]}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{user ? avatarInitials(user) : '--'}</Text>
      </View>
      <View style={styles.texts}>
        <Text style={styles.phoneText}>{user ? maskPhone(user.phone) : '未登录'}</Text>
        <Text style={styles.subText}>用户 ID {user ? user.id : '-'}</Text>
      </View>
    </View>
  );
}

function SectionTitle({ label }: { label: string }) {
  return <Text style={styles.sectionTitle}>{label}</Text>;
}

/**
 * Static-balance credits card (P13 first card). Balance/usage numbers are
 * placeholders until M2-5 wires the real quote/balance source; 充值 is a
 * disabled chip. The 积分规则 entry opens the P13 half-sheet explainer.
 */
function VoiceCreditsCard() {
  const open = useCreditsSheetStore((state) => state.open);
  const setOpen = useCreditsSheetStore((state) => state.setOpen);

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={[styles.rowAvatar, { backgroundColor: colors.accentSoft }]}>
          <CoinGlyph color={colors.accentDeep} size={18} />
        </View>
        <View style={styles.texts}>
          <Text style={styles.rowTitle}>{BALANCE_LABEL}</Text>
          <Text style={styles.subText}>{MONTHLY_USAGE_LABEL}</Text>
        </View>
        {/* 充值 disabled until M2-5 ships the recharge flow. */}
        <View style={styles.rechargeChip}>
          <Text style={styles.rechargeText}>{RECHARGE_LABEL}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={CREDITS_RULES_LABEL}
          onPress={() => setOpen(true)}
          hitSlop={8}
        >
          {({ pressed }) => (
            <Text style={[styles.rulesLink, pressed && styles.pressed]}>{CREDITS_RULES_LABEL}</Text>
          )}
        </Pressable>
      </View>
      {/* Read-only recognition row: P-R1-01 option B, no switch control. */}
      <View style={[styles.row, styles.rowLast]}>
        <View style={styles.rowAvatar}>
          <MicGlyph color={colors.fg60} size={18} />
        </View>
        <View style={styles.texts}>
          <Text style={styles.rowTitle}>{RECOGNITION_TITLE}</Text>
          <Text style={styles.subText}>{RECOGNITION_SUB}</Text>
        </View>
      </View>
      <CreditsSheet open={open} onClose={() => setOpen(false)} />
    </View>
  );
}

/** P13 half-sheet explainer with its four fixed blocks. */
export function CreditsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetMask}>
        <Pressable style={styles.sheetBackdrop} onPress={onClose} accessibilityLabel="关闭" />
        <View style={styles.sheetPanel}>
          <View style={styles.sheetGrab} />
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>{CREDITS_SHEET_TITLE}</Text>
            <Pressable accessibilityRole="button" onPress={onClose} hitSlop={10}>
              <Text style={styles.sheetClose}>✕</Text>
            </Pressable>
          </View>
          <View style={styles.sheetBody}>
            <SheetBlock title="积分怎么算">
              语音转文字按秒计费；开始时先预扣 60 秒，结束后按实际用量结算，多退少补。
            </SheetBlock>
            <SheetBlock title="两种识别方式">
              边说边出字（按住时逐字显示）/ 整段转文字（松开后转出），单价不同，以结算提示为准。
            </SheetBlock>
            <SheetBlock title="积分从哪来">
              通过充值获得（充值入口见本页）；新用户赠送以活动页为准。
            </SheetBlock>
            <SheetBlock title="余额不足时">语音按钮会暂时置灰，充值后立即恢复。</SheetBlock>
          </View>
          {/* 去充值 stays greyed out: the recharge flow is M2-5 scope. */}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: true }}
            disabled
            style={styles.sheetRecharge}
          >
            <Text style={styles.sheetRechargeText}>去充值（即将上线）</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function SheetBlock({ title, children }: { title: string; children: string }) {
  return (
    <View style={styles.sheetBlock}>
      <Text style={styles.sheetBlockTitle}>{title}</Text>
      <Text style={styles.sheetBlockBody}>{children}</Text>
    </View>
  );
}

/** Row glyph keys; rendered inside EntryRow to avoid ReactNode type bridging. */
type EntryGlyph = 'scan' | 'shield' | 'devices';

function EntryRow({
  glyph,
  title,
  sub,
  onPress,
  last,
}: {
  glyph: EntryGlyph;
  title: string;
  sub: string;
  onPress: () => void;
  last?: boolean;
}) {
  const icon =
    glyph === 'scan' ? (
      <ScanGlyph color={colors.fg60} size={18} />
    ) : glyph === 'shield' ? (
      <ShieldGlyph color={colors.fg60} size={18} />
    ) : (
      <TabIcon name="devices" color={colors.fg60} size={18} />
    );
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, !last && styles.rowDivided, pressed && styles.pressed]}
    >
      <View style={styles.rowAvatar}>{icon}</View>
      <View style={styles.texts}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.subText}>{sub}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

// --- glyphs drawn without icon fonts ----------------------------------------
// Scan/mic mirror the prototype's #i-scan / #i-mic line icons; the brand mark
// stands in for #i-logo (same "P" monogram the old HomeScreen entry used).

function ScanGlyph({ color, size }: { color: string; size: number }) {
  const corner = size * 0.32;
  const stroke = 2;
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: corner,
          height: corner,
          borderTopWidth: stroke,
          borderLeftWidth: stroke,
          borderTopLeftRadius: size * 0.08,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: corner,
          height: corner,
          borderTopWidth: stroke,
          borderRightWidth: stroke,
          borderTopRightRadius: size * 0.08,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: corner,
          height: corner,
          borderBottomWidth: stroke,
          borderLeftWidth: stroke,
          borderBottomLeftRadius: size * 0.08,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: corner,
          height: corner,
          borderBottomWidth: stroke,
          borderRightWidth: stroke,
          borderBottomRightRadius: size * 0.08,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: size / 2 - 1,
          left: size * 0.08,
          right: size * 0.08,
          height: 2,
          borderRadius: 1,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

function MicGlyph({ color, size }: { color: string; size: number }) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center' }}>
      <View
        style={{
          width: size * 0.3,
          height: size * 0.42,
          marginTop: size * 0.08,
          borderWidth: 2,
          borderRadius: size * 0.15,
          borderColor: color,
        }}
      />
      <View
        style={{
          width: size * 0.58,
          height: size * 0.24,
          marginTop: size * 0.05,
          borderLeftWidth: 2,
          borderRightWidth: 2,
          borderBottomWidth: 2,
          borderBottomLeftRadius: size * 0.29,
          borderBottomRightRadius: size * 0.29,
          borderColor: color,
        }}
      />
      <View
        style={{
          width: 2,
          height: size * 0.14,
          marginTop: size * 0.03,
          borderRadius: 1,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

function ShieldGlyph({ color, size }: { color: string; size: number }) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: size * 0.66,
          height: size * 0.78,
          borderWidth: 2,
          borderColor: color,
          borderTopLeftRadius: size * 0.12,
          borderTopRightRadius: size * 0.12,
          borderBottomLeftRadius: size * 0.33,
          borderBottomRightRadius: size * 0.33,
        }}
      />
    </View>
  );
}

function CoinGlyph({ color, size }: { color: string; size: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 99,
        borderWidth: 2,
        borderColor: color,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color, fontSize: size * 0.55, fontWeight: '700', lineHeight: size * 0.6 }}>
        ¥
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 28,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: 14,
    paddingVertical: 4,
    paddingHorizontal: 14,
  },
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 99,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.accentDeep,
  },
  texts: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  phoneText: {
    fontSize: fontSize.body,
    fontWeight: '600',
    color: colors.foreground,
  },
  subText: {
    fontSize: fontSize.toast,
    color: colors.fg50,
  },
  sectionTitle: {
    marginTop: 18,
    marginBottom: 8,
    marginHorizontal: 4,
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.fg60,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowDivided: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowAvatar: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: colors.fieldBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: {
    fontSize: fontSize.body - 1,
    fontWeight: '500',
    color: colors.foreground,
  },
  rechargeChip: {
    height: 24,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: colors.fieldBg,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.55,
  },
  rechargeText: {
    fontSize: 11.5,
    color: colors.fg60,
  },
  rulesLink: {
    fontSize: 12,
    color: colors.accent,
    fontWeight: '500',
  },
  chevron: {
    fontSize: 20,
    color: colors.fg40,
  },
  versionRow: {
    marginTop: 16,
    textAlign: 'center',
    fontSize: fontSize.toast,
    color: colors.fg40,
  },
  signOut: {
    marginTop: 18,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.buttonBorder,
  },
  signOutText: {
    fontSize: fontSize.button,
    fontWeight: '500',
    color: colors.destructive,
  },
  pressed: {
    opacity: 0.7,
  },
  sheetMask: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(17,19,23,0.35)',
  },
  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  sheetPanel: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 26,
    gap: 12,
  },
  sheetGrab: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 99,
    backgroundColor: colors.fieldBg,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },
  sheetClose: {
    fontSize: 15,
    color: colors.fg50,
    paddingHorizontal: 6,
  },
  sheetBody: {
    gap: 11,
  },
  sheetBlock: {
    gap: 2,
  },
  sheetBlockTitle: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.foreground,
  },
  sheetBlockBody: {
    fontSize: 12,
    lineHeight: 20,
    color: colors.fg60,
  },
  sheetRecharge: {
    height: 46,
    borderRadius: 12,
    backgroundColor: colors.fieldBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetRechargeText: {
    fontSize: fontSize.button,
    fontWeight: '600',
    color: colors.fg40,
  },
});
