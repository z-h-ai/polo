// PreviewSheet (POL-24 card step 5) — the P09 结构化预览 full-screen overlay.
//
// Four states (PRD §⑦ 后处理 + 预览交互):
//   ① loading        正在结构化文本…（自动分段、去口头词）
//   ② done           可滚动结构化文本（可编辑，候选规则 v1.6）+ 底部「发送」
//                    + 右上「使用原文」+ 结算说明 okbar（用时 Xs·预扣已退回 Ys）
//   ③ raw toggle     「识别原文 · 未经处理」chip + 右上「使用结构化」一键切回
//   ④ failed         保留识别原文 + 「智能整理暂时不可用」errbar，可直接编辑/发送
// 发送 → SessionController（M1-11 sessions 链路）；取消 → 已取消.

import { useRef } from 'react';
import type { ComponentRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { VoiceSnapshot } from './usePressToTalk';
import { colors } from '../theme/tokens';

const PREVIEW_TITLE = '语音转文字';
const RAW_CHIP = '识别原文 · 未经处理';
const LOADING_TITLE = '正在结构化文本…';
const LOADING_SUB = '正在智能整理：自动分段、去掉口头词';
const FAILED_BAR = '智能整理暂时不可用，已保留识别原文；可直接发送，或先编辑再发送。';

export function PreviewSheet({
  snapshot,
  onSend,
  onCancel,
  onToggleRaw,
  onDraftChange,
}: {
  snapshot: VoiceSnapshot;
  onSend: () => void;
  onCancel: () => void;
  onToggleRaw: () => void;
  onDraftChange: (text: string) => void;
}) {
  const inputRef = useRef<ComponentRef<typeof TextInput> | null>(null);
  const processing = snapshot.processing;
  const showRawChip = snapshot.showRaw || processing.status === 'failed';
  const canSend = snapshot.draft.trim().length > 0;

  return (
    <View style={styles.screen}>
      <View style={styles.navbar}>
        <Pressable accessibilityRole="button" accessibilityLabel="取消" onPress={onCancel}>
          <Text style={styles.navAction}>取消</Text>
        </Pressable>
        <Text style={styles.navTitle} numberOfLines={1}>
          {PREVIEW_TITLE}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={snapshot.showRaw ? '使用结构化' : '使用原文'}
          onPress={onToggleRaw}
          disabled={processing.status !== 'done'}
          style={styles.navRight}
        >
          <Text style={[styles.navAction, processing.status !== 'done' && styles.navActionDisabled]}>
            {snapshot.showRaw ? '使用结构化' : '使用原文'}
          </Text>
        </Pressable>
      </View>

      {processing.status === 'loading' ? (
        <View style={styles.loadingBody}>
          <View style={styles.spinnerGrid}>
            {Array.from({ length: 9 }, (_, index) => (
              <View key={index} style={styles.spinnerCell} />
            ))}
          </View>
          <Text style={styles.loadingTitle}>{LOADING_TITLE}</Text>
          <Text style={styles.loadingSub}>{LOADING_SUB}</Text>
        </View>
      ) : (
        <View style={styles.body}>
          {showRawChip ? <Text style={styles.rawChip}>{RAW_CHIP}</Text> : null}
          {processing.status === 'failed' ? (
            <View style={styles.errbar}>
              <Text style={styles.errbarText}>{FAILED_BAR}</Text>
            </View>
          ) : null}
          <View style={styles.card}>
            <ScrollView contentContainerStyle={styles.cardContent} showsVerticalScrollIndicator>
              <TextInput
                ref={inputRef}
                style={styles.editor}
                value={snapshot.draft}
                onChangeText={onDraftChange}
                multiline
                textAlignVertical="top"
                accessibilityLabel="语音预览文本，可直接编辑"
              />
            </ScrollView>
            {processing.status !== 'failed' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="编辑"
                style={({ pressed }) => [styles.editButton, pressed && styles.pressed]}
                onPress={() => inputRef.current?.focus()}
              >
                <Text style={styles.editGlyph}>✎</Text>
              </Pressable>
            ) : null}
          </View>
          {snapshot.settlement ? <Text style={styles.okbar}>{snapshot.settlement.label}</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送"
            disabled={!canSend}
            style={({ pressed }) => [styles.sendButton, (!canSend || pressed) && styles.sendDisabled]}
            onPress={onSend}
          >
            <Text style={styles.sendLabel}>发送</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.background,
    zIndex: 30,
  },
  navbar: {
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  navAction: {
    fontSize: 13.5,
    color: colors.accent,
  },
  navActionDisabled: {
    color: colors.fg40,
  },
  navRight: {
    minWidth: 72,
    alignItems: 'flex-end',
  },
  navTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '600',
    color: colors.foreground,
  },
  loadingBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 40,
  },
  spinnerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: 38,
    gap: 4,
  },
  spinnerCell: {
    width: 10,
    height: 10,
    borderRadius: 2,
    backgroundColor: colors.accent,
    opacity: 0.75,
  },
  loadingTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.foreground,
  },
  loadingSub: {
    fontSize: 12,
    lineHeight: 20,
    color: colors.fg50,
    textAlign: 'center',
  },
  body: {
    flex: 1,
    padding: 16,
    paddingBottom: 24,
    gap: 12,
  },
  rawChip: {
    alignSelf: 'flex-start',
    fontSize: 11.5,
    fontWeight: '600',
    color: colors.fg60,
    backgroundColor: colors.fieldBg,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  errbar: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.destructiveBorder,
    backgroundColor: colors.destructiveBg,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errbarText: {
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.destructive,
  },
  card: {
    flex: 1,
    minHeight: 0,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.white,
    padding: 16,
  },
  cardContent: {
    flexGrow: 1,
  },
  editor: {
    fontSize: 14.5,
    lineHeight: 26,
    color: colors.fg60,
    padding: 0,
  },
  editButton: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.buttonBorder,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editGlyph: {
    fontSize: 15,
    color: colors.fg60,
  },
  okbar: {
    fontSize: 11.5,
    color: colors.success,
  },
  sendButton: {
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.85,
  },
  sendLabel: {
    color: colors.white,
    fontSize: 14.5,
    fontWeight: '600',
  },
});
