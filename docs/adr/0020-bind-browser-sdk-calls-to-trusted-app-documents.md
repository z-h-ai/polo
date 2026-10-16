# Bind browser SDK calls to trusted App documents

Status: accepted for the SDK v1 implementation, 2026-10-16.

The creator SDK supports browser frontends without a creator-operated backend. It must reuse App runtime authorization, Host query and billing without exposing provider credentials or weakening the HTTP gateway's Origin rejection.

A successful Main-owned Catalog START issues a private static capability and registers the exact host window, Workspace, loopback UI origin and runtime/scope generations. Main forces the isolated sandbox preload. Electron omits preload paths/additional arguments from `getLastWebPreferences`, so a Main-generated one-use attach ticket travels privately in preload argv, never in the page API. `did-attach-webview` observes the actual guest/host; the first main-frame IPC claims that ticket and checks the exact origin and current scope. Subsequent calls, async boundaries and frame-targeted events repeat document/runtime/capability validation. New main-frame documents cancel old calls; same-document hash changes do not.

`@polo-ai/sdk` owns the browser-safe DTO/protocol source. Main retains the shared authoritative query schema. `prompt` and observable `run` each execute one query through the existing coordinator, admission, Pi Host executor, receipt and finish. Neither token streaming nor an Agent tool loop is promised. Public query status and billing settlement remain independent. A partial query finishes its billing run as completed but stays partial to the application.

Document cleanup is bounded, per original run and independent of aborted caller signals. It reuses the metadata outbox for admission/receipt only. Finish remains in-memory plus existing teardown/server timeout handling; an unconfirmed finish is exposed as unknown, never as a persistent recovery guarantee. No automatic prompt retry is performed.

The quotation example uses browser File selection, strict UTF-8/CSV checks, deterministic integer-cent arithmetic, safe text rendering, validated edits and Blob downloads. It adds no filesystem permission. The tarball carries the only maintained Skill/example sources and builds outside the monorepo. Distribution uses the existing Catalog delivery path; local ZIP import and whitelists are outside scope.
