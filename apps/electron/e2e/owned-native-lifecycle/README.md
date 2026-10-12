# Owned native lifecycle loader

`loader.cjs` is the maintained source for new full-production-Main FAULT fixtures.
The historical prepared loader at SHA256
`45c1a3596aae9f3b6cbbc92f7a928199317ec5b5a8dc2ee30912e1db50b7bcf1`
waited for asynchronous owner readiness before requiring Main. This could cross
Electron ready before Sentry initialization and privileged scheme registration.
Historical per-run copies remain evidence for their original inputs.

For FAULT launches this loader requires the unchanged production Main
synchronously, while holding its `app.whenReady()` bootstrap until the owner
has registered the actual process, both actual listeners, fault mode and rules,
and the real port registration interceptor. It restores the readiness method
on success and failure. Failed admission exits only the owned app, keeps any
captured bootstrap closed, and writes the existing private failure receipt.
DIRECT preserves the original synchronous Main return. Production Main is not
patched, and Sentry remains enabled.

Generate a new immutable loader input from committed sources:

```sh
node scripts/generate-owned-native-lifecycle.mjs --out /tmp/new-owned-native-loader
node --test apps/electron/e2e/owned-native-lifecycle/loader.unit.cjs
```

The generator refuses existing directories, uncommitted source bytes and
unignored repository output. Bind the generated loader path and SHA256 in the
existing owner config/helper review, together with the original Main/preload,
renderer manifest and proxy/wrapper hashes. The owner must continue its actual
PID/birth/PGID registration and `lsof` listener verification independently of
window startup. Do not copy old helper approvals to these new bytes. The loader
creates no resources when imported and supplies no acceptance verdict.

Unit tests simulate Electron readiness and identity, with an actual loopback
control socket. They verify synchronous loading, admission ordering, timeout,
Main failure, bundle drift and owner mismatch; they do not prove an actual
Electron launch, provider requests, product journeys or formal Acceptance.
