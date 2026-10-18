// Tab-bar icons and unread badge (POL-19).
//
// Pure react-native shapes mirroring the prototype line icons (#i-msg,
// #i-mac, #i-user in polo-mobile-prototype.html). @expo/vector-icons is not a
// dependency of this app, so the glyphs are drawn with Views; active
// state is conveyed by the accent tint the tab bar passes down. The extra
// 'phone' glyph (V-11) serves device rows: platform-unknown cards fall back
// to it instead of the person icon.

import { Text, View, StyleSheet, type ColorValue } from 'react-native';

import { unreadBadgeLabel } from '../state/unread';
import { colors } from '../theme/tokens';

const STROKE = 2;

export type TabIconName = 'messages' | 'devices' | 'profile' | 'phone';

function MessagesIcon({ color, size }: { color: ColorValue; size: number }) {
  const bubble = size * 0.82;
  return (
    <View style={iconBox(size)}>
      <View
        style={{
          width: bubble,
          height: bubble * 0.78,
          marginTop: size * 0.08,
          borderRadius: bubble * 0.3,
          borderWidth: STROKE,
          borderColor: color,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: size * 0.09,
        }}
      >
        <View style={{ width: size * 0.08, height: size * 0.08, borderRadius: 99, backgroundColor: color }} />
        <View style={{ width: size * 0.08, height: size * 0.08, borderRadius: 99, backgroundColor: color }} />
        <View style={{ width: size * 0.08, height: size * 0.08, borderRadius: 99, backgroundColor: color }} />
      </View>
    </View>
  );
}

function DevicesIcon({ color, size }: { color: ColorValue; size: number }) {
  const screen = size * 0.86;
  return (
    <View style={[iconBox(size), { justifyContent: 'flex-end' }]}>
      <View
        style={{
          width: screen,
          height: screen * 0.64,
          borderRadius: size * 0.12,
          borderWidth: STROKE,
          borderColor: color,
        }}
      />
      <View
        style={{
          width: size,
          height: Math.max(2, size * 0.11),
          borderRadius: 99,
          backgroundColor: color,
          marginTop: size * 0.08,
        }}
      />
    </View>
  );
}

function ProfileIcon({ color, size }: { color: ColorValue; size: number }) {
  const head = size * 0.4;
  const shoulders = size * 0.74;
  return (
    <View style={[iconBox(size), { justifyContent: 'flex-end' }]}>
      <View
        style={{
          width: head,
          height: head,
          borderRadius: 99,
          borderWidth: STROKE,
          borderColor: color,
        }}
      />
      <View
        style={{
          width: shoulders,
          height: size * 0.38,
          marginTop: size * 0.06,
          overflow: 'hidden',
          alignItems: 'center',
        }}
      >
        <View
          style={{
            width: shoulders,
            height: shoulders,
            borderRadius: shoulders / 2,
            borderWidth: STROKE,
            borderColor: color,
            marginTop: size * 0.14,
          }}
        />
      </View>
    </View>
  );
}

// Phone handset glyph (V-11): rounded-rect outline + home line, same
// line-icon style as the tab glyphs — mirrors the prototype phone icon in
// P02/P12 device rows.
function PhoneIcon({ color, size }: { color: ColorValue; size: number }) {
  return (
    <View style={iconBox(size)}>
      <View
        style={{
          width: size * 0.58,
          height: size * 0.88,
          borderRadius: size * 0.14,
          borderWidth: STROKE,
          borderColor: color,
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingBottom: size * 0.09,
        }}
      >
        <View
          style={{
            width: size * 0.14,
            height: STROKE,
            borderRadius: 99,
            backgroundColor: color,
          }}
        />
      </View>
    </View>
  );
}

function iconBox(size: number) {
  return { width: size, height: size, alignItems: 'center', justifyContent: 'center' } as const;
}

export function TabIcon({ name, color, size }: { name: TabIconName; color: ColorValue; size: number }) {
  switch (name) {
    case 'messages':
      return <MessagesIcon color={color} size={size} />;
    case 'devices':
      return <DevicesIcon color={color} size={size} />;
    case 'profile':
      return <ProfileIcon color={color} size={size} />;
    case 'phone':
      return <PhoneIcon color={color} size={size} />;
  }
}

/**
 * Unread bubble pinned to the top-right of the 消息 tab icon. Static 0/1 for
 * now (shell card); the store flips it without any tab re-render beyond the
 * badge slot itself.
 */
export function TabBadge({ count }: { count: number }) {
  const label = unreadBadgeLabel(count);
  if (label === null) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: -4,
    right: -7,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 99,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.white,
    fontSize: 10.5,
    fontWeight: '600',
  },
});
