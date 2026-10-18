// VoicePanel (POL-24 card step 5) — the P06/P07/P08 按住面板 + 禁按/权限引导.
//
// Renders (in priority order):
//   insufficientPanel → P07 余额不足禁按态（置灰+锁+「语音积分不足」+去充值+积分规则）
//   micPermission denied → 应用内引导 + 系统设置（UX-7 三态）
//   recording/recognizing → P06 STREAM（流式文字+光标+声波纹+松开/上滑提示）
//                          | P07 FILE（波形+松开转文字+预扣 chip，无流式文字）
//                          | P08 转写中（SSE 渐进+取消）
//   else → null（待按态仅保留 InputBar 麦克风 + 引导气泡，P06 屏1）.
//
// 波纹/波形由本地 metering（snapshot.level）驱动，不依赖服务端（PRD §⑦）.

import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { PressToTalkActions, VoiceSnapshot } from './usePressToTalk';
import { levelToBars } from './wav';
import { colors } from '../theme/tokens';
import { useVoiceQuotaGate } from './billingClient';

export const RECHARGE_TOAST = '充值入口即将开放（运营侧建设中）';
const WAVE_BARS = 7;

export function VoicePanel({
  snapshot,
  actions,
  onOpenCredits,
  onRecharge,
}: {
  snapshot: VoiceSnapshot;
  actions: PressToTalkActions;
  onOpenCredits: () => void;
  /** 充值跳转占位（运营侧）. */
  onRecharge: () => void;
}) {
  const quotaStatus = useVoiceQuotaGate((state) => state.status);

  if (snapshot.insufficientPanel) {
    return (
      <InsufficientPanel
        notQuotable={quotaStatus === 'not_quotable'}
        onClose={actions.closeInsufficientPanel}
        onOpenCredits={onOpenCredits}
        onRecharge={onRecharge}
      />
    );
  }
  if (snapshot.micPermission === 'denied' && !snapshot.micPanelDismissed) {
    return <MicDeniedPanel onOpenSettings={actions.openMicSettings} onClose={actions.closeInsufficientPanel} />;
  }
  if (snapshot.phase !== 'recording' && snapshot.phase !== 'recognizing') {
    return null;
  }

  const stream = snapshot.mode === 'STREAM';
  const fingerDown = snapshot.fingerDown;
  const transcribing = snapshot.phase === 'recognizing' && !fingerDown;

  return (
    <View style={styles.panel} pointerEvents="box-none">
      <View style={styles.grab} />
      {/* chips 行：模式 chip + 预扣计时 */}
      <View style={styles.chipRow}>
        {transcribing ? (
          <View style={[styles.chip, styles.chipInf]}>
            <Text style={styles.chipInfText}>转写中…</Text>
          </View>
        ) : (
          <Text style={[styles.chip, stream ? styles.chipAccent : styles.chipPlain]}>
            {stream ? '边说边出字' : '整段转文字'}
          </Text>
        )}
        <Text style={styles.timer}>
          {formatElapsed(snapshot.elapsedSec)}
          <Text style={styles.timerMut}>  /  {snapshot.preholdChipLabel}</Text>
        </Text>
      </View>
      {/* 预扣进度细条（候选规则） */}
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            { width: `${Math.min(100, (snapshot.elapsedSec / Math.max(1, snapshot.preholdSeconds)) * 100)}%` },
          ]}
        />
      </View>
      {/* 临近上限提醒 / FILE 预扣说明 */}
      {snapshot.nearCap ? (
        <View style={[styles.chip, styles.chipInf, styles.nearCap]}>
          <Text style={styles.chipInfText}>
            还有 {Math.max(0, snapshot.maxDurationSec - snapshot.elapsedSec)} 秒达到单次上限
          </Text>
        </View>
      ) : !stream && fingerDown ? (
        <View style={[styles.chip, styles.chipInf, styles.nearCap]}>
          <Text style={styles.chipInfText}>已预扣 {snapshot.preholdSeconds} 秒积分 · 取消自动退回</Text>
        </View>
      ) : null}

      {transcribing ? (
        <>
          {/* P08 转写中：SSE 渐进 + 流式光标 + 取消 */}
          <Text style={styles.stream} numberOfLines={6}>
            {snapshot.partialText.length > 0 ? snapshot.partialText : '识别结果正在逐句显示'}
            <Text style={styles.cursor}>▍</Text>
          </Text>
          <Text style={styles.mutSmall}>取消将全额退回预扣积分</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="取消转写"
            style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}
            onPress={actions.cancelRecognizing}
          >
            <Text style={styles.cancelLabel}>取消</Text>
          </Pressable>
        </>
      ) : stream ? (
        <>
          {/* P06 STREAM：流式文字逐字上屏 + 光标 */}
          <Text style={styles.stream} numberOfLines={6}>
            {snapshot.partialText}
            <Text style={styles.cursor}>▍</Text>
          </Text>
          <View style={styles.hintWaveRow}>
            <View style={styles.hints}>
              <Text style={styles.hint}>
                <Text style={styles.hintBold}>松开</Text>　转文字
              </Text>
              <Text style={[styles.hint, snapshot.swipeArmed && styles.hintArmed]}>
                <Text style={styles.hintBold}>上滑</Text>　取消
              </Text>
            </View>
            <Wave level={snapshot.level} height={28} />
          </View>
        </>
      ) : (
        <>
          {/* P07 FILE：仅波形 + 松开转文字（协议限制整段上送，无流式文字） */}
          <View style={styles.fileCenter}>
            <Wave level={snapshot.level} height={56} />
            <Text style={styles.releaseTitle}>松开转文字</Text>
            <Text style={styles.mutSmall}>松开后整段转成文字，按住时不逐字显示</Text>
          </View>
          <View style={styles.hints}>
            <Text style={[styles.hint, snapshot.swipeArmed && styles.hintArmed]}>
              <Text style={styles.hintBold}>上滑</Text>　取消
            </Text>
          </View>
        </>
      )}
      <View style={styles.micBig}>
        <MicGlyph scale={1.6} />
      </View>
    </View>
  );
}

// -- P07 余额不足禁按态 ---------------------------------------------------------

function InsufficientPanel({
  notQuotable,
  onClose,
  onOpenCredits,
  onRecharge,
}: {
  notQuotable: boolean;
  onClose: () => void;
  onOpenCredits: () => void;
  onRecharge: () => void;
}) {
  return (
    <View style={styles.panel} pointerEvents="box-none">
      <View style={styles.grab} />
      <View style={styles.infobar}>
        <Text style={styles.infobarText}>
          {notQuotable ? '语音服务暂不可用，请稍后再试' : '语音积分不足，暂无法使用语音输入'}
        </Text>
      </View>
      <View style={styles.lockWrap}>
        <View style={[styles.micBig, styles.micBigLocked]}>
          <MicGlyph scale={1.6} locked />
        </View>
        <View style={styles.lockBadge}>
          <View style={styles.lockShackle} />
          <View style={styles.lockBody} />
        </View>
      </View>
      {notQuotable ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="去充值"
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
          onPress={onRecharge}
        >
          <Text style={styles.primaryLabel}>去充值</Text>
        </Pressable>
      )}
      <Pressable accessibilityRole="button" accessibilityLabel="查看积分规则" onPress={onOpenCredits}>
        <Text style={styles.creditsLink}>查看积分规则</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} style={styles.closeRow}>
        <Text style={styles.mutSmall}>关闭</Text>
      </Pressable>
    </View>
  );
}

// -- 麦克风权限被拒（应用内引导 + 系统设置） -------------------------------------

function MicDeniedPanel({
  onOpenSettings,
  onClose,
}: {
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  return (
    <View style={styles.panel} pointerEvents="box-none">
      <View style={styles.grab} />
      <View style={styles.infobar}>
        <Text style={styles.infobarText}>麦克风权限未开启，无法使用语音输入</Text>
      </View>
      <Text style={styles.mutSmall}>请在系统设置中允许 Polo 使用麦克风</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="去设置"
        style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        onPress={onOpenSettings}
      >
        <Text style={styles.primaryLabel}>去设置</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} style={styles.closeRow}>
        <Text style={styles.mutSmall}>关闭</Text>
      </Pressable>
    </View>
  );
}

// -- 声波纹 / 波形（本地 metering 驱动） ------------------------------------------

export function Wave({ level, height }: { level: number; height: number }) {
  const bars = levelToBars(level, WAVE_BARS);
  return (
    <View style={[styles.wave, { height }]}>
      {bars.map((value, index) => (
        <View
          key={index}
          style={[
            styles.waveBar,
            { height: `${Math.round(value * 100)}%` },
          ]}
        />
      ))}
    </View>
  );
}

export function MicGlyph({ scale = 1, locked = false }: { scale?: number; locked?: boolean }) {
  return (
    <View style={{ transform: [{ scale }] }}>
      <View style={[styles.micCapsule, locked && styles.micGlyphLocked]} />
      <View style={[styles.micArc, locked && styles.micGlyphLocked]} />
      <View style={[styles.micStem, locked && styles.micGlyphLocked]} />
    </View>
  );
}

/** 00:07 形态的按住计时. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

// -- styles ---------------------------------------------------------------------

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 18,
    gap: 10,
    alignItems: 'center',
  },
  grab: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.fieldBg,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'stretch',
  },
  chip: {
    fontSize: 11.5,
    fontWeight: '600',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  chipAccent: {
    color: colors.accent,
    backgroundColor: 'rgba(138,117,205,0.1)',
  },
  chipPlain: {
    color: colors.fg60,
    backgroundColor: colors.fieldBg,
  },
  chipInf: {
    backgroundColor: 'rgba(237,153,14,0.12)',
  },
  chipInfText: {
    color: '#8c5f27',
    fontSize: 11.5,
    fontWeight: '600',
  },
  nearCap: {
    alignSelf: 'flex-start',
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
  },
  timer: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.foreground,
  },
  timerMut: {
    fontWeight: '500',
    color: colors.fg50,
    fontSize: 11.5,
  },
  barTrack: {
    alignSelf: 'stretch',
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.fieldBg,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  stream: {
    alignSelf: 'stretch',
    minHeight: 44,
    fontSize: 15,
    lineHeight: 24,
    color: colors.foreground,
  },
  cursor: {
    color: colors.accent,
    fontWeight: '600',
  },
  hintWaveRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  hints: {
    gap: 4,
  },
  hint: {
    fontSize: 12,
    color: colors.fg50,
  },
  hintArmed: {
    color: colors.destructive,
    fontWeight: '600',
  },
  hintBold: {
    fontWeight: '700',
    color: colors.foreground,
  },
  mutSmall: {
    fontSize: 11,
    color: colors.fg50,
  },
  fileCenter: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
  },
  releaseTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },
  cancelButton: {
    alignSelf: 'stretch',
    height: 40,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.buttonBorder,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelLabel: {
    fontSize: 13,
    color: colors.foreground,
    fontWeight: '500',
  },
  wave: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  waveBar: {
    width: 3,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  micBig: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  micGlyphLocked: {
    backgroundColor: colors.fg40,
  },
  micCapsule: {
    width: 8,
    height: 13,
    borderRadius: 4,
    backgroundColor: colors.white,
  },
  micArc: {
    position: 'absolute',
    bottom: 13,
    width: 14,
    height: 8,
    borderRadius: 7,
    borderWidth: 1.5,
    borderTopWidth: 0,
    borderColor: colors.white,
    backgroundColor: 'transparent',
  },
  micStem: {
    position: 'absolute',
    bottom: 9,
    width: 1.5,
    height: 4,
    backgroundColor: colors.white,
  },
  infobar: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(237,153,14,0.25)',
    backgroundColor: 'rgba(237,153,14,0.1)',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  infobarText: {
    fontSize: 12.5,
    color: '#8c5f27',
    lineHeight: 18,
  },
  lockWrap: {
    marginVertical: 6,
  },
  micBigLocked: {
    backgroundColor: colors.fieldBg,
  },
  lockBadge: {
    position: 'absolute',
    top: -4,
    right: -10,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.foreground,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockShackle: {
    position: 'absolute',
    top: 4,
    width: 8,
    height: 6,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.background,
    backgroundColor: 'transparent',
  },
  lockBody: {
    position: 'absolute',
    bottom: 4,
    width: 10,
    height: 7,
    borderRadius: 2,
    backgroundColor: colors.background,
  },
  primaryButton: {
    alignSelf: 'stretch',
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.85,
  },
  primaryLabel: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  creditsLink: {
    color: colors.accent,
    fontSize: 13,
  },
  closeRow: {
    padding: 4,
  },
});
