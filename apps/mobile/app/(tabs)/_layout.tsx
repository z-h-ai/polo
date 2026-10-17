import { View } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TAB_ITEMS } from '../../src/navigation/tabConfig';
import { TabBadge, TabIcon, type TabIconName } from '../../src/components/TabIcons';
import { useUnreadStore } from '../../src/state/unread';
import { colors, fontSize } from '../../src/theme/tokens';

// Bottom tab shell (POL-19): 消息 / 设备 / 我的, the only navigator of its
// kind in the app. Selected tab is accent-tinted; bar totals >=78px including
// the safe-area padding (candidate rule; minHeight instead of fixed height so
// large insets never clip the bar).
const TAB_BAR_MIN_HEIGHT = 78;

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const unreadCount = useUnreadStore((state) => state.count);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.fg40,
        tabBarLabelStyle: {
          fontSize: 10.5,
          fontWeight: '500',
        },
        tabBarStyle: {
          backgroundColor: colors.white,
          borderTopColor: colors.border,
          minHeight: TAB_BAR_MIN_HEIGHT,
          paddingBottom: Math.max(insets.bottom, 8),
          paddingTop: 6,
        },
      }}
    >
      {TAB_ITEMS.map((item) => (
        <Tabs.Screen
          key={item.key}
          name={item.route}
          options={{
            title: item.label,
            tabBarIcon:
              item.key === 'messages'
                ? ({ color, size }) => (
                    // Badge slot: TabBadge pins itself to this wrapper's corner.
                    <View>
                      <TabIcon name={item.key as TabIconName} color={color} size={size} />
                      <TabBadge count={unreadCount} />
                    </View>
                  )
                : ({ color, size }) => (
                    <TabIcon name={item.key as TabIconName} color={color} size={size} />
                  ),
          }}
        />
      ))}
    </Tabs>
  );
}
