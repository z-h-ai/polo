import { QrScanScreen } from '../src/screens/scan/QrScanScreen';

// POL-15: QR scan route. expo-router derives the route from the file name, so
// no _layout registration is needed. Reachable only while signed in (AuthGate
// redirects unauthenticated users to /login).
export default function ScanQr() {
  return <QrScanScreen />;
}
