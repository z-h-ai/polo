import type { CreatorAppPayloadEntry } from '../creator-app-publishing.ts'

export interface CreatorAppPayloadFixture {
  id: 'static' | 'python' | 'js' | 'next-standalone'
  expected: { runtime: 'static' | 'python' | 'js'; path: string }
  entries: CreatorAppPayloadEntry[]
}

const pythonServer = `import os

HOST = os.environ["HOST"]
PORT = int(os.environ["PORT"])
HEALTH_PATH = "/health"
HEALTH_HEADER = "X-Polo-App-Health-Token"
HEALTH_TOKEN = os.environ["POLO_APP_HEALTH_TOKEN"]
`

const javascriptServer = `const host = process.env.HOST;
const port = Number(process.env.PORT);
const healthPath = "/health";
const healthHeader = "X-Polo-App-Health-Token";
const healthToken = process.env.POLO_APP_HEALTH_TOKEN;
`

export const CREATOR_APP_PAYLOAD_FIXTURES: CreatorAppPayloadFixture[] = [
  {
    id: 'static',
    expected: { runtime: 'static', path: 'index.html' },
    entries: [
      {
        path: 'index.html',
        content: '<!doctype html><link rel="stylesheet" href="assets/app.css"><main>Static payload ready</main>',
      },
      { path: 'assets/app.css', content: 'main { color: #17324d; }' },
    ],
  },
  {
    id: 'python',
    expected: { runtime: 'python', path: 'server/main.py' },
    entries: [
      { path: 'server/main.py', content: pythonServer },
      { path: 'pyproject.toml', content: '[tool.polo-fixture]\nname = "valid-python"' },
      { path: 'uv.lock', content: '# Deterministic dependency lock marker.' },
    ],
  },
  {
    id: 'js',
    expected: { runtime: 'js', path: 'server/index.js' },
    entries: [
      { path: 'server/index.js', content: javascriptServer },
      { path: 'package.json', content: '{"name":"valid-js","private":true,"type":"module"}' },
      { path: 'bun.lock', content: '{"workspaces":{},"packages":{}}' },
    ],
  },
  {
    id: 'next-standalone',
    expected: { runtime: 'js', path: 'server/index.js' },
    entries: [
      { path: 'server/index.js', content: javascriptServer },
      { path: 'server/node_modules/next/package.json', content: '{"name":"next","version":"15.0.0"}' },
      { path: 'server/public/favicon.ico', bytes: new Uint8Array([0, 0, 1, 0]) },
      { path: 'server/.next/static/chunks/app.js', content: 'self.__next_f = self.__next_f || [];' },
      { path: 'package.json', content: '{"name":"valid-next-standalone","private":true}' },
      { path: 'bun.lock', content: '{"workspaces":{},"packages":{}}' },
    ],
  },
]
