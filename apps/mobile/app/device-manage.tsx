import { DeviceManageScreen } from '../src/screens/devices/DeviceManageScreen';

// POL-16: P12 device management route (binding list + unbind confirm sheet).
// Reachable only while signed in (AuthGate). Entry: 设备 Tab rows/管理 action,
// or the P04 bind-limit screen's 前往设备管理.
export default function DeviceManage() {
  return <DeviceManageScreen />;
}
