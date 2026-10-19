// P12 解绑二次确认弹层 (POL-241).
//
// Bottom-sheet Modal over a 50% dim, per the prototype frame: grab handle,
// 「解绑 …？」 title, consequence copy, destructive 确认解绑 + 取消. Copy is
// the PRD §⑤ 定稿 wording: unbind takes effect immediately but the relay's
// 60s authorization cache means the network can take up to a minute to
// fully disconnect; re-use always requires re-pairing. Buttons disable
// while the revoke request is in flight.

import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { UNBIND_SHEET_COPY } from '../lib/devicesUi';
import { colors, fontSize, radius } from '../theme/tokens';

export function UnbindConfirmSheet({
  visible,
  targetName,
  busy,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  /** Display name of the Mac being unbound (sheet title). */
  targetName: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.scrim}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="取消解绑" onPress={onCancel} />
        <View style={styles.panel}>
          <View style={styles.grab} />
          <Text style={styles.title} numberOfLines={2}>
            {UNBIND_SHEET_COPY.titlePrefix}
            {targetName}
            {UNBIND_SHEET_COPY.titleSuffix}
          </Text>
          <Text style={styles.body}>{UNBIND_SHEET_COPY.body}</Text>
          <Text style={styles.body}>{UNBIND_SHEET_COPY.bodyTiming}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={onConfirm}
            style={({ pressed }) => [styles.confirm, (busy || pressed) && styles.dim]}
          >
            <Text style={styles.confirmLabel}>
              {busy ? UNBIND_SHEET_COPY.confirmBusy : UNBIND_SHEET_COPY.confirm}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onCancel}
            style={({ pressed }) => [styles.cancel, busy && styles.dim, pressed && styles.dim]}
          >
            <Text style={styles.cancelLabel}>{UNBIND_SHEET_COPY.cancel}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  panel: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 30,
    gap: 12,
  },
  grab: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: 99,
    backgroundColor: colors.fieldBg,
    marginBottom: 2,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    color: colors.foreground,
  },
  body: {
    fontSize: 13,
    lineHeight: 23,
    textAlign: 'center',
    color: colors.fg60,
  },
  confirm: {
    height: 48,
    borderRadius: radius.field,
    backgroundColor: colors.destructive,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  confirmLabel: {
    color: colors.white,
    fontSize: fontSize.button,
    fontWeight: '600',
  },
  cancel: {
    height: 48,
    borderRadius: radius.field,
    backgroundColor: colors.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.buttonBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelLabel: {
    color: colors.foreground,
    fontSize: fontSize.button,
    fontWeight: '500',
  },
  dim: {
    opacity: 0.6,
  },
});
