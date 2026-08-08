# `@z-h-ai/shared@0.13.0` Creator App publishing handoff

## Published boundary

`0.13.0` adds one public subpath without widening the package root:

```text
@z-h-ai/shared/creator-app-publishing
```

The existing Creator Skill subpaths remain unchanged. Package root imports,
private source paths, and protocol internals remain unsupported.

## Canonical Creator Payload contract

| Payload | Runtime | Canonical entry |
|---|---|---|
| Static | `static` | `index.html` |
| Python | `python` | `server/main.py` |
| Plain JavaScript | `js` | `server/index.js` |
| Next.js standalone | `js` | `server/index.js` |

Next.js standalone retains its required runtime companions under `server/`,
including the allowlisted standalone dependency subset, `server/public`, and
`server/.next/static`.

Canonical entries take precedence over legacy root-level entries. Legacy
entries remain compatibility inputs only. If multiple candidates imply
different runtimes, analysis blocks with `ambiguous_runtime`; it never asks a
Creator to choose a runtime. Entry selection is returned only when more than
one safe entry remains for the same detected runtime.

Dynamic services must include inspectable `HOST`, `PORT`, `/health`,
`POLO_APP_HEALTH_TOKEN`, and `X-Polo-App-Health-Token` evidence. Analysis does
not build, install dependencies, or execute uploaded code.

## Shared limits

Consumers import `CREATOR_APP_PAYLOAD_LIMITS` or
`CREATOR_APP_PAYLOAD_MAX_BYTES`. The canonical compressed archive limit is
`200 MiB`. A transport may impose a lower local limit, but it must describe
that as a transport limit rather than redefining the Creator Payload contract.

## POL-69 migration

After registry publication and proof succeed, Polo Admin must pin exactly:

```json
{
  "dependencies": {
    "@z-h-ai/shared": "0.13.0"
  }
}
```

Organization Console should import analysis, canonical Bundle generation,
entry constants, and limits from the public subpath. It must not copy the
implementation into the Admin repository.

The package proof covers CommonJS, ESM, TypeScript 6, Next.js production build
and runtime route consumption. The shared unit suite separately proves Static,
Python, Plain JavaScript, and Next.js standalone payloads through real ZIP
decode, analysis, platform-owned Manifest generation, canonical repack, and
production Bundle validation.

Candidate proof command:

```sh
bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts \
  --allow-dirty-snapshot \
  --output-dir /tmp/z-h-ai-shared-0.13.0-proof
```

Local tarball evidence is not registry proof. Publication is complete only
after the immutable `shared-v0.13.0` workflow publishes the exact candidate and
the registry-backed clean consumer proof passes.
