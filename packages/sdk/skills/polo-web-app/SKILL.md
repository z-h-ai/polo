---
name: polo-web-app
description: Build a browser-only static Polo App using @polo-ai/sdk for single-query AI, user-selected text or CSV inputs, validated editable results and browser downloads. Use for frontend creator Apps hosted in Polo; CLI agents and backend services use other interfaces.
---

Build the requested frontend using the public SDK. The distributed SDK package is the source of truth: read [its API and compatibility contract](../../README.md) before coding. The complete [quotation example](../../examples/quotation-assistant/) contains the real API usage, strict file/CSV validation, integer-cent arithmetic, editable rows, cancellation and Blob exports. Adapt it rather than inventing host APIs. These paths are relative to this installed package, including when it came from a local tarball.

## Host and execution contract

Import `{ polo, PoloError }` from `@polo-ai/sdk`. Use `polo.prompt({ prompt, responseFormat: 'json_object', signal })` for a Promise, or `polo.run(...)` for `{ result, cancel, onStatus }`. `onStatus` returns an unsubscribe function. `polo.isAvailable()` is a read-only availability check. Handle rejected `PoloError.code`; an ordinary browser must clearly explain that AI requires opening the App from Polo's authorized catalog. Do not return demonstration AI output as success.

Version 0.1.x requires bridge protocol v1 in a Polo build that contains this bridge. It does not imply that the already released Polo 0.16.3 supports it. Each call is one query, with real lifecycle statuses, and no tool loop or token streaming. Do not wrap CLI execution or slice final text into pretend streaming events. No backend, provider credentials, custom origins, raw host IPC, filesystem permissions or identity/payer options are needed or exposed.

Preserve both result axes: `status` is `completed` or `partial`; `settlement` is `confirmed`, `no_charge`, `pending` or `unknown`. Partial output is incomplete. Pending/unknown billing must be described honestly and must never trigger another model request. User cancellation is a request; wait for the original result and cleanup. A late cancellation can still return an already completed provider result. Remove status listeners in `finally`. Do not retry prompts automatically after errors, navigation, reconnect or refresh.

## Frontend workflow

Let the user prepare and preview the actual submitted input, then click to generate. Show waiting, cancellation, failure and completion. For quotations, validate returned JSON against a narrow schema, check integer-cent prices against user-confirmed inputs and recompute totals deterministically. Render text safely with DOM text or framework escaping, allow validated edits and require user review before export. Never treat model-generated totals as authoritative.

Read only a user-selected browser `File`. Check extension and byte size before reading. `File.text()` alone replaces malformed UTF-8; use `arrayBuffer()` and fatal UTF-8 decoding to reject invalid encoding. The example accepts UTF-8 CSV/TXT up to 256 KiB. Reuse its strict CSV parser and protect CSV exports against spreadsheet formulas as well as quote/newline escapes. Offer CSV/JSON Blob downloads with an `<a download>` on the current page, then release the URL. Do not add arbitrary path-write IPC. Verify downloads inside the real Polo guest; a normal browser preview alone does not prove this.

## Build and delivery

The creator needs Node 20+ (or compatible Bun), npm and the example's declared build dependencies. End users need only a compatible Polo host.

In an isolated project, install the supplied tarball, then copy `node_modules/@polo-ai/sdk/examples/quotation-assistant` to a working directory. In that directory, run `npm install /absolute/path/to/polo-ai-sdk-0.1.0.tgz` (the absolute tarball path is chosen locally, not embedded in source), followed by:

```sh
npm run build
npm run package
```

`polo-payload.zip` is a Creator upload payload with root `index.html`, `app.js`, `app.css` and `polo-app.json`. No preregistered App ID/version is needed. Normal Creator upload assigns the identity/version and writes the final `polo-app.json` with `runtime: static`, `entry: ["index.html"]`, `healthcheck: "/"`, `webPath: "/"` and `permissions: []`. Follow the returned validation/review requirements, publish with the actual impact confirmation, then distribute through an authorized circle. Preserve separate upload-payload and final-bundle hashes. Do not use a historical final bundle with a `web` directory entry as the raw upload payload. The single `metadata` object in `scripts/build.mjs` supplies the Enterprise v1 name, description, icon, instructions, author and source; update these declarations when deriving the example. For direct Enterprise internal import, choose a unique local identity using `POLO_APP_ID=my-company-quote-example POLO_APP_VERSION=1.0.0 npm run build` and package normally. The Owner must import, inspect, adopt the version, confirm scope and enable the independent instance. It does not inherit circle authorization. Creator repackaging replaces the local manifest, so its downloaded final bundle may lack Enterprise declarations; keep these delivery identities distinct. Build commands are relative to the copied example and do not depend on a monorepo/workspace. SDK runtime/types must stay browser-only.

Deliver source and the static ZIP for the existing authorized creator publication/catalog delivery workflow. A ZIP does not grant entitlement and cannot be dragged into Polo as a new local import. Do not add a whitelist, publish a work or change account configuration merely to demonstrate it. Validate manifest/ZIP shape, plain-browser failure, real authorized START, cancellation and downloaded bytes. Label controlled Admin/Provider evidence separately; unavailable real catalog/provider/billing is an explicit verification gap. Publication and formal acceptance remain separate steps.
