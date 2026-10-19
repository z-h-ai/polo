// P13 积分规则半屏弹层 (POL-249) — four fixed blocks per the prototype:
// 积分怎么算 / 两种识别方式 / 积分从哪来 / 余额不足时.
// Entry points: 禁按面板「查看积分规则」(P07) + 预览/面板引导. 去充值 is a
// placeholder (充值支付页 = 运营侧, card 不做).

import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme/tokens';

export const CREDITS_RULES_TITLE = '积分规则说明';

interface CreditRuleBlock {
  title: string;
  body: string;
}

export const CREDIT_RULE_BLOCKS: CreditRuleBlock[] = [
  {
    title: '积分怎么算',
    body: '语音转文字按秒计费；开始时先预扣 60 秒，结束后按实际用量结算，多退少补。',
  },
  {
    title: '两种识别方式',
    body: '边说边出字（按住时逐字显示）/ 整段转文字（松开后转出），单价不同，以结算提示为准。',
  },
  {
    title: '积分从哪来',
    body: '通过充值获得（充值入口见「我的」页）；新用户赠送以活动页为准。',
  },
  {
    title: '余额不足时',
    body: '语音按钮会暂时置灰，充值后立即恢复。',
  },
];

export function CreditsSheet({
  visible,
  onClose,
  onRecharge,
}: {
  visible: boolean;
  onClose: () => void;
  /** 充值跳转占位（运营侧页面，本卡不实现支付）. */
  onRecharge?: () => void;
}) {
  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Pressable accessibilityLabel="关闭积分规则" style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grab} />
          <Text style={styles.title}>{CREDITS_RULES_TITLE}</Text>
          <View style={styles.blocks}>
            {CREDIT_RULE_BLOCKS.map((block) => (
              <View key={block.title} style={styles.block}>
                <Text style={styles.blockTitle}>{block.title}</Text>
                <Text style={styles.blockBody}>{block.body}</Text>
              </View>
            ))}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="去充值"
            style={({ pressed }) => [styles.recharge, pressed && styles.pressed]}
            onPress={onRecharge}
          >
            <Text style={styles.rechargeLabel}>去充值</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(17,19,23,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 28,
  },
  grab: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.fieldBg,
    marginBottom: 14,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: 14,
  },
  blocks: {
    gap: 14,
    marginBottom: 18,
  },
  block: {
    gap: 3,
  },
  blockTitle: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.foreground,
  },
  blockBody: {
    fontSize: 12,
    lineHeight: 19,
    color: colors.fg60,
  },
  recharge: {
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.85,
  },
  rechargeLabel: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
});
