// 消息 Tab (POL-19, prototype M01).
//
// Two states like M01:
//   - 空态 (default until POL-18 wires the session data): big glyph,
//     还没有消息, 副文, 「去绑定电脑」 primary button -> /pair (the POL-16
//     pairing flow), boundary chip about 多会话管理.
//   - 有会话占位: conversation-card structure in place (device name + time +
//     summary + unread bubble + task-result chip); tapping the card is a
//     no-op until the session page exists (POL-18). Below the list sits the
//     greyed-out P3 system-push mock row with its 「P3 · 示意」 badge.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { LargeTitle } from '../../components/LargeTitle';
import { TabIcon } from '../../components/TabIcons';
import { colors, fontSize } from '../../theme/tokens';

export const EMPTY_TITLE = '还没有消息';
export const EMPTY_SUBTITLE = '绑定电脑后，从这里给电脑上的 Polo AI 发消息、派任务';
export const BIND_BUTTON_LABEL = '去绑定电脑';
export const BOUNDARY_CHIP =
  '当前支持绑定多台电脑，每台电脑 1 个会话 · 多会话管理即将上线';
export const PUSH_HINT = '离开 App 时，任务结果将通过系统通知提醒 · 即将上线';

/** Structural placeholder for the M1-11/P05 session list (POL-18 fills it). */
export interface ConversationSummary {
  id: string;
  deviceName: string;
  online: boolean;
  lastTime: string;
  summary: string;
  unread: number;
  /** e.g. 「任务已完成 · 用时 26 秒」; null hides the chip. */
  taskChip: string | null;
}

export function MessagesTab({
  conversations = [],
}: {
  conversations?: ConversationSummary[];
}) {
  const router = useRouter();
  const hasConversations = conversations.length > 0;

  return (
    <View style={styles.screen}>
      <LargeTitle title="消息" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={
          hasConversations ? styles.listContent : styles.emptyContent
        }
        showsVerticalScrollIndicator={false}
      >
        {hasConversations ? (
          <ConversationList conversations={conversations} />
        ) : (
          <EmptyState onPressBind={() => router.push('/pair')} />
        )}
      </ScrollView>
    </View>
  );
}

function EmptyState({ onPressBind }: { onPressBind: () => void }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyGlyph}>
        <TabIcon name="messages" color={colors.fg40} size={44} />
      </View>
      <Text style={styles.emptyTitle}>{EMPTY_TITLE}</Text>
      <Text style={styles.emptySubtitle}>{EMPTY_SUBTITLE}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onPressBind}
        style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
      >
        <View style={styles.primaryButtonInner}>
          {/* Prototype btnP pairs the mac glyph with the label (M01). */}
          <TabIcon name="devices" color={colors.white} size={16} />
          <Text style={styles.primaryButtonLabel}>{BIND_BUTTON_LABEL}</Text>
        </View>
      </Pressable>
      <View style={styles.chip}>
        <Text style={styles.chipText}>{BOUNDARY_CHIP}</Text>
      </View>
    </View>
  );
}

function ConversationList({ conversations }: { conversations: ConversationSummary[] }) {
  return (
    <View style={styles.list}>
      {conversations.map((conversation) => (
        <ConversationCard key={conversation.id} conversation={conversation} />
      ))}
      <Text style={styles.pushHint}>{PUSH_HINT}</Text>
      {/* P3 system-push mock: greyed out, not pressable, 「P3 · 示意」 badge. */}
      <View style={styles.pushWrap}>
        <View style={styles.pushBadge}>
          <Text style={styles.pushBadgeText}>P3 · 示意</Text>
        </View>
        <View style={styles.pushRow}>
          <View style={styles.pushHead}>
            {/* Brand monogram stands in for the prototype's #i-logo mark. */}
            <Text style={styles.pushLogo}>P</Text>
            <Text style={styles.pushApp}>Polo</Text>
            <Text style={styles.pushTime}>· 现在</Text>
          </View>
          <Text style={styles.pushBody}>{conversations[0]?.deviceName ?? ''}：任务已完成 ✅</Text>
        </View>
      </View>
    </View>
  );
}

function ConversationCard({ conversation }: { conversation: ConversationSummary }) {
  // Press target reserved for the POL-18 session page; no navigation yet.
  return (
    <View style={styles.card}>
      <View style={styles.cardAvatarWrap}>
        <View style={styles.cardAvatar}>
          <TabIcon name="devices" color={colors.accentDeep} size={20} />
        </View>
        {conversation.online ? <View style={styles.onlineDot} /> : null}
      </View>
      <View style={styles.cardTexts}>
        <View style={styles.cardTopRow}>
          <Text style={styles.cardName} numberOfLines={1}>
            {conversation.deviceName}
          </Text>
          <Text style={styles.cardTime}>{conversation.lastTime}</Text>
        </View>
        <Text style={styles.cardSummary} numberOfLines={1}>
          {conversation.summary}
        </Text>
        {conversation.taskChip !== null ? (
          <View style={styles.taskChip}>
            <Text style={styles.taskChipText}>{conversation.taskChip}</Text>
          </View>
        ) : null}
      </View>
      <UnreadBubble count={conversation.unread} />
    </View>
  );
}

export function UnreadBubble({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.unread}>
      <Text style={styles.unreadText}>{count > 99 ? '99+' : String(count)}</Text>
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
  emptyContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 36,
    gap: 12,
  },
  listContent: {
    padding: 16,
    paddingTop: 8,
    gap: 10,
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
  emptySubtitle: {
    fontSize: 12.5,
    lineHeight: 21,
    textAlign: 'center',
    color: colors.fg50,
  },
  primaryButton: {
    width: '100%',
    height: 46,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  primaryButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primaryButtonLabel: {
    color: colors.white,
    fontSize: fontSize.button,
    fontWeight: '600',
  },
  chip: {
    height: 'auto',
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.buttonBorder,
    backgroundColor: colors.white,
  },
  chipText: {
    fontSize: 11.5,
    lineHeight: 17,
    textAlign: 'center',
    color: colors.fg60,
  },
  pressed: {
    opacity: 0.8,
  },
  list: {
    gap: 10,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 14,
  },
  cardAvatarWrap: {
    position: 'relative',
  },
  cardAvatar: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  onlineDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 11,
    height: 11,
    borderRadius: 99,
    backgroundColor: colors.success,
    borderWidth: 2,
    borderColor: colors.background,
  },
  cardTexts: {
    flex: 1,
    minWidth: 0,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardName: {
    flex: 1,
    fontSize: fontSize.body,
    fontWeight: '600',
    color: colors.foreground,
  },
  cardTime: {
    fontSize: 11,
    color: colors.fg50,
  },
  cardSummary: {
    marginTop: 3,
    fontSize: 12,
    color: colors.fg50,
  },
  taskChip: {
    marginTop: 6,
    alignSelf: 'flex-start',
    height: 20,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskChipText: {
    fontSize: 10.5,
    color: colors.accentDeep,
  },
  unread: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 999,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '600',
  },
  pushHint: {
    marginTop: 2,
    fontSize: 11,
    lineHeight: 17,
    textAlign: 'center',
    color: colors.fg40,
  },
  pushWrap: {
    position: 'relative',
    marginTop: 10,
  },
  pushBadge: {
    position: 'absolute',
    top: -8,
    right: 10,
    zIndex: 2,
    paddingHorizontal: 6,
    height: 16,
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.buttonBorder,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pushBadgeText: {
    fontSize: 9.5,
    color: colors.fg50,
  },
  pushRow: {
    opacity: 0.6,
    backgroundColor: colors.background,
    borderRadius: 14,
    padding: 12,
  },
  pushHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pushLogo: {
    fontSize: 12,
    lineHeight: 14,
    fontWeight: '800',
    color: colors.accent,
  },
  pushApp: {
    fontSize: 11.5,
    fontWeight: '600',
    color: colors.foreground,
  },
  pushTime: {
    fontSize: 10.5,
    color: colors.fg50,
  },
  pushBody: {
    marginTop: 4,
    fontSize: 12.5,
    lineHeight: 20,
    color: colors.foreground,
  },
});
