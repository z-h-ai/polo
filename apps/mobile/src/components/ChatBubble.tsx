// P05 chat bubbles — 指令气泡 (user, right, light grey) and Mac 回复气泡
// (assistant, left, white card). Plain text with newline wrapping per card
// 不做 list (no rich text / markdown).

import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme/tokens';

export function ChatBubble({ role, text }: { role: 'user' | 'assistant'; text: string }) {
  const isUser = role === 'user';
  return (
    <View style={[styles.bubble, isUser ? styles.user : styles.assistant]}>
      <Text style={[styles.text, isUser ? styles.userText : styles.assistantText]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    maxWidth: '86%',
    borderRadius: 16,
    paddingHorizontal: 15,
    paddingVertical: 11,
  },
  user: {
    alignSelf: 'flex-end',
    backgroundColor: 'rgba(17,19,23,0.05)',
    borderTopRightRadius: 6,
  },
  assistant: {
    alignSelf: 'flex-start',
    backgroundColor: colors.white,
    borderRadius: 8,
    borderTopLeftRadius: 3,
    // --shadow-minimal approximation
    shadowColor: '#111317',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  text: {
    fontSize: 14,
    lineHeight: 22,
  },
  userText: {
    color: colors.foreground,
  },
  assistantText: {
    color: colors.foreground,
  },
});
