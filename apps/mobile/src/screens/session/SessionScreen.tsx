// P05 会话页 (POL-18) — 消息气泡 + 事件卡流 + 连接状态条 + 离线暂存横幅 +
// 安全态. Data comes from the session store; sends go through the
// SessionController (sessions:create / sendMessage over the ConnectionManager).
//
// Screen states (prototype P05):
//   在线        绿/紫状态条 + 气泡/事件卡全流程
//   暂存        重连状态条 + 「Mac 离线：消息将暂存最多 5 分钟…」横幅 + 已暂存卡
//   超时失败    发送失败卡 + 重新发送
//   执行失败    执行失败卡 + 重新发送（不滞留执行中）
//   安全态      绑定已解除状态条 + errbar + 输入禁用（对端撤销绑定）

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatBubble } from '../../components/ChatBubble';
import { ConnectionStatusBar } from '../../components/ConnectionStatusBar';
import { EventCard } from '../../components/EventCard';
import { InputBar } from '../../components/InputBar';
import {
  ATTACHMENT_TOAST,
  FATAL_BANNER,
  STAGING_BANNER,
  eventCardRow,
} from '../../session/eventCard';
import { ensureSessionWiring, sessionController } from '../../session/sessionRpc';
import { hasStagedMessages, useSessionStore } from '../../session/sessionStore';
import type { ChatEntry } from '../../session/sessionStore';
import { colors, fontSize } from '../../theme/tokens';

const TOAST_MS = 1800;

export function SessionScreen({
  deviceName = '我的电脑',
  onBack,
}: {
  deviceName?: string;
  onBack?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const entries = useSessionStore((state) => state.entries);
  const connStatus = useSessionStore((state) => state.connStatus);
  const macOffline = useSessionStore((state) => state.macOffline);
  const fatal = useSessionStore((state) => state.fatal);
  const [toast, setToast] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Idempotent event-stream wiring (manager.on/onStatus/onFatal → store).
  useEffect(() => {
    ensureSessionWiring();
  }, []);

  // Local 5-minute countdown tick — only while something is staged.
  const staged = hasStagedMessages({ entries });
  useEffect(() => {
    if (!staged) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [staged, entries.length]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const handleSend = useCallback((text: string) => {
    void sessionController.send(text);
  }, []);

  const handleResend = useCallback((entryId: string) => {
    void sessionController.resend(entryId);
  }, []);

  const fatalState = fatal !== null;
  const showStagingBanner = !fatalState && (macOffline || staged);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.navbar}>
        <BackGlyph onBack={onBack} />
        <Text style={styles.navTitle} numberOfLines={1}>
          {deviceName}
        </Text>
        <View style={styles.navSpacer} />
      </View>
      <ConnectionStatusBar status={connStatus} fatal={fatalState} />
      {fatalState ? (
        <View style={[styles.banner, styles.errbar]}>
          <Text style={[styles.bannerText, { color: colors.destructive }]}>{FATAL_BANNER}</Text>
        </View>
      ) : showStagingBanner ? (
        <View style={[styles.banner, styles.infobar]}>
          <Text style={[styles.bannerText, { color: '#8c5f27' }]}>{STAGING_BANNER}</Text>
        </View>
      ) : null}
      <ScrollView
        ref={scrollRef}
        style={styles.flow}
        contentContainerStyle={styles.flowContent}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        showsVerticalScrollIndicator={false}
      >
        {entries.map((entry) => (
          <EntryBlock key={entry.id} entry={entry} nowMs={nowMs} onResend={handleResend} />
        ))}
      </ScrollView>
      <InputBar
        onSend={handleSend}
        onAttachmentPress={() => showToast(ATTACHMENT_TOAST)}
        disabled={fatalState}
        disabledPlaceholder="绑定解除后不可发送"
      />
      {toast !== null ? (
        <View pointerEvents="none" style={styles.toastWrap}>
          <View style={styles.toast}>
            <Text style={styles.toastText}>{toast}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function EntryBlock({
  entry,
  nowMs,
  onResend,
}: {
  entry: ChatEntry;
  nowMs: number;
  onResend: (entryId: string) => void;
}) {
  if (entry.role === 'assistant') {
    return (
      <ChatBubble role="assistant" text={entry.text} />
    );
  }
  return (
    <View style={styles.userBlock}>
      <ChatBubble role="user" text={entry.text} />
      {entry.turn ? (
        <EventCard
          row={eventCardRow(entry.turn, nowMs)}
          onResend={
            entry.turn.state === 'failed' ? () => onResend(entry.id) : undefined
          }
        />
      ) : null}
    </View>
  );
}

function BackGlyph({ onBack }: { onBack?: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="返回"
      onPress={onBack}
      style={styles.navBack}
    >
      <Text style={styles.navBackGlyph}>‹</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  navbar: {
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  navBack: {
    minWidth: 44,
  },
  navBackGlyph: {
    fontSize: 26,
    lineHeight: 30,
    color: colors.fg60,
  },
  navTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '600',
    color: colors.foreground,
  },
  navSpacer: {
    minWidth: 44,
  },
  banner: {
    marginHorizontal: 14,
    marginTop: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  infobar: {
    borderColor: 'rgba(237,153,14,0.25)',
    backgroundColor: 'rgba(237,153,14,0.1)',
  },
  errbar: {
    borderColor: colors.destructiveBorder,
    backgroundColor: colors.destructiveBg,
  },
  bannerText: {
    fontSize: fontSize.error,
    lineHeight: 19,
  },
  flow: {
    flex: 1,
  },
  flowContent: {
    padding: 16,
    gap: 12,
  },
  userBlock: {
    alignItems: 'flex-end',
    gap: 6,
  },
  toastWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 110,
    alignItems: 'center',
  },
  toast: {
    backgroundColor: 'rgba(17,19,23,0.85)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  toastText: {
    color: colors.white,
    fontSize: fontSize.toast,
  },
});
