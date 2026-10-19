import { MessagesTab } from '../../src/screens/tabs/MessagesTab';

// 消息 Tab route (POL-244). This is also the tabs root: after sign-in
// AuthGate lands the user on '/' which resolves here (post-login landing =
// 消息 Tab, per the old app/index.tsx behavior this file replaces).
export default function MessagesRoute() {
  return <MessagesTab />;
}
