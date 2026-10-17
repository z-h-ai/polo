import { HomeScreen } from '../src/screens/HomeScreen';

// POL-14: authenticated home route. The @polo-ai/shared/protocol import moved
// into HomeScreen so the monorepo smoke check (shared package resolves through
// tsc and Metro) stays alive.
export default function Index() {
  return <HomeScreen />;
}
