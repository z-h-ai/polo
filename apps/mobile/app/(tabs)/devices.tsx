import { DeviceListScreen } from '../../src/screens/devices/DeviceListScreen';

// 设备 Tab route — the real P02 device list (POL-16), replacing the POL-19
// placeholder. Reachable only while signed in (AuthGate).
export default function DevicesRoute() {
  return <DeviceListScreen />;
}
