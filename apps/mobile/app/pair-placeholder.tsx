import { PairPlaceholderScreen } from '../src/screens/pair/PairPlaceholderScreen';

// POL-19: P03 route placeholder for the 消息 Tab 「去绑定电脑」 button.
// Reachable only while signed in (AuthGate). POL-16 replaces the screen body.
export default function PairPlaceholder() {
  return <PairPlaceholderScreen />;
}
