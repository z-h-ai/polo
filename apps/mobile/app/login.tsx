import { LoginScreen } from '../src/screens/LoginScreen';

// POL-239: unauthenticated route. AuthGate redirects here when no valid
// session exists.
export default function Login() {
  return <LoginScreen />;
}
