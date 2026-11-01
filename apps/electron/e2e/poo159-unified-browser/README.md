# POO-159 native regression harness

Runs the production file interceptor/sidebar, browser manager, persistent canvas
carrier, shared guest hook, UiCardRegistry and webview attach gate in Electron.
The fixture supplies an isolated account/space/session and the IPC transport;
it does not exercise a signed-in production backend or a real AI provider.
No fixture content is installed in the product.

From the repository root:

```sh
POO159_SOURCE_REF='<reviewed working-tree fingerprint>' \
POO159_BUILD_DIR=/tmp/poo159-native-build \
POO159_EVIDENCE_DIR=/tmp/poo159-native-evidence \
bun apps/electron/e2e/poo159-unified-browser/run.mjs
```

Use a fresh build directory when production inputs change. The runner respects
an explicit source reference; otherwise it records HEAD. Build/profile paths
are task owned. Main writes `runtime.json`, screenshots and capture receipts,
then releases its managers, server, windows and isolated process. The caller
archives evidence and removes reproducible builds after inspection.

Coverage includes webpage detach/hide/return, opaque HTML/script isolation,
HTML source and hide recovery, HTML-to-browser presentation, trusted canvas
migration with live guest identity and JavaScript/input/scroll state, transcript
focus, close/reopen, foreign partition/registration refusal, unavailable carrier
error/retry, host reload and authority-driven scope revocation. The missing
carrier and invalid guest attempts deliberately produce refusal/error logs.

The requested native window is 1440×900; capture receipts record the actual
viewport and DPR (1440×841 on the capture machine). Host `capturePage()` excludes
native views. Browser pages, canvas carriers and canvas guests are captured
separately; screenshots are never composited to simulate a window capture.
Ordinary HTML uses an opaque sandbox and supports inline scripts; relative
filesystem resources remain blocked and never receive canvas permissions.

Historical before evidence uses a full `git archive` of the pinned baseline,
including its workspace packages, CSS and production components. A task-local
fixture adapter uses the old AppShell mounting condition and old preview router;
`POO159_BASELINE=1` records old outcomes without requiring the old product to
satisfy the new lifecycle contract. The archived source and fixture inputs live
with the review evidence, not as a second maintained product implementation.
