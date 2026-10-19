// Viewfinder overlay for QR scanning (POL-240).
//
// Four corner brackets + a looping scan line, per prototype P10. Kept
// dependency-free and camera-agnostic so the M1-9 pairing scan (P03) can
// reuse it over any preview surface.

import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { colors } from '../theme/tokens';

interface ScanFrameProps {
  /** Square side length of the viewfinder box (layout units). */
  size?: number;
  cornerColor?: string;
  lineColor?: string;
}

const CORNER_LENGTH = 28;
const CORNER_WIDTH = 4;
/** Full sweep of the scan line in ms (top -> bottom -> top). */
const SWEEP_MS = 2200;

export function ScanFrame({
  size = 248,
  cornerColor = colors.accent,
  lineColor = colors.accent,
}: ScanFrameProps) {
  const position = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(position, {
          toValue: 1,
          duration: SWEEP_MS / 2,
          useNativeDriver: true,
        }),
        Animated.timing(position, {
          toValue: 0,
          duration: SWEEP_MS / 2,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [position]);

  // Line travels between the corner insets, not edge to edge.
  const travel = size - CORNER_LENGTH * 2;

  return (
    <View style={[styles.box, { width: size, height: size }]}>
      <Corner position="topLeft" color={cornerColor} />
      <Corner position="topRight" color={cornerColor} />
      <Corner position="bottomLeft" color={cornerColor} />
      <Corner position="bottomRight" color={cornerColor} />
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.line,
          {
            backgroundColor: lineColor,
            width: size - CORNER_LENGTH,
            transform: [
              {
                translateY: position.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, travel],
                }),
              },
            ],
          },
        ]}
      />
    </View>
  );
}

function Corner({ position, color }: { position: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'; color: string }) {
  return (
    <View
      style={[
        styles.corner,
        position === 'topLeft' && styles.topLeft,
        position === 'topRight' && styles.topRight,
        position === 'bottomLeft' && styles.bottomLeft,
        position === 'bottomRight' && styles.bottomRight,
        { borderColor: color },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  box: {
    alignSelf: 'center',
  },
  corner: {
    position: 'absolute',
    width: CORNER_LENGTH,
    height: CORNER_LENGTH,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderTopLeftRadius: 10,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderTopRightRadius: 10,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderBottomLeftRadius: 10,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderBottomRightRadius: 10,
  },
  line: {
    position: 'absolute',
    top: CORNER_LENGTH,
    height: 2,
    borderRadius: 1,
    alignSelf: 'center',
    opacity: 0.9,
  },
});
