import { QrConfirmScreen } from '../src/screens/scan/QrConfirmScreen';

// POL-240: QR authorization confirm route. Receives { qrId, secret } params
// from the scan route; expo-router derives the route from the file name.
export default function QrConfirm() {
  return <QrConfirmScreen />;
}
