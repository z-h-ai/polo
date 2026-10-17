import { PairFlowScreen } from '../src/screens/pairing/PairFlowScreen';

// POL-16: P03/P04 pairing flow route (scan -> manual/confirm -> success).
// Accepts ?mode=manual to land directly on the 6-digit entry. Replaces the
// POL-19 pair-placeholder route; reachable only while signed in (AuthGate).
export default function Pair() {
  return <PairFlowScreen />;
}
