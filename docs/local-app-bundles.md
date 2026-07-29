# Local App Bundle contract

Polo installs trusted creator bundles into a device-local, versioned runtime.
Every archive must contain `polo-app.json` at its root and use one root process
and one HTTP port.

## Manifest

```json
{
  "schemaVersion": 1,
  "appId": "com.example.notes",
  "version": "1.0.0",
  "name": "Notes",
  "runtime": "static",
  "entry": ["dist"],
  "healthcheck": "/health",
  "webPath": "/",
  "permissions": [],
  "platforms": ["darwin", "win32", "linux"],
  "architectures": ["arm64", "x64"],
  "startTimeoutMs": 30000
}
```

- `runtime` is `static`, `python`, or `js`.
- `entry` is an argument array, never a shell command. Its first item is a
  bundle-relative file (or the static content directory); remaining items are
  passed as literal arguments.
- `healthcheck` and `webPath` are local HTTP paths beginning with `/`.
- `platforms`, `architectures`, `name`, and `startTimeoutMs` are optional.
- Bundle paths must not be absolute, contain `..`, or use archive links.

## Runtime conventions

- `static`: `entry[0]` points to a dist directory or HTML file. Polo's built-in
  static server owns the port and answers the declared health-check path.
- `python`: the bundle includes `pyproject.toml` and `uv.lock`; `entry[0]`
  points to the Python server file. Polo uses its bundled `uv`, creates a
  version-specific environment, and starts it offline after preparation.
- `js`: `entry[0]` points to the Bun server entry. If dependencies are not
  already prepared, include `package.json` and `bun.lock`/`bun.lockb`. Next.js
  bundles should ship a directly runnable standalone output.

Python backends serving a React UI must serve the React dist themselves so the
app still has one root process and one port.

## Injected environment

Dynamic runtimes receive `PORT`, `HOST=127.0.0.1`, `POLO_APP_ID`,
`POLO_APP_VERSION`, `POLO_APP_DATA_DIR`, and `POLO_APP_BUNDLE_DIR`. Runtime
cache paths are isolated by app and version. User data is stored outside
version directories and survives updates and normal uninstall.
