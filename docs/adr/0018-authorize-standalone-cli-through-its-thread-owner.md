# ADR 0018: Authorize standalone CLI execution through its Thread owner

Status: Accepted for the owned-connection runtime repair, 2026-10-16.
Scope: ADRs 0001/0002/0003/0005/0006/0009/0010 standalone CLI; no SDK or managed compute support.

## Context

ProductSpace admission now guards desktop session RPCs, backend callbacks and
session events. A standalone CLI has an exclusive Thread lease and private
rooted storage, but no desktop account or committed ProductSpace. Reusing the
desktop handlers fails at `sessions:create` and, independently, at callbacks and
event delivery. An origin/profile bypass would grant excessive authority and
could launder an Admin-managed connection through a synthetic resume.

## Decision

The server composition uses an owned execution broker on its private parent
stdin bootstrap. Before opening the RPC listener it verifies parent PID/birth,
owner lease and canonical Thread/snapshot/storage paths. An internal,
monotonically revocable authority binds exactly one root session and CLI client.
A separate minimal RPC registration admits only create/send/cancel, the two
resume commands and model selection within the bootstrapped owned connection.
The ordinary server/Electron registration and ProductSpace guards stay intact.

SessionManager and the callback registry share an explicit local operation
inventory, map identity and runtime owner generation. Model credential proxies
and tool admission recheck the host lease; events reach only its bound client.
Revocation forbids new work and late delivery while internal cancellation and
resource disposal remain possible. CLI startup errors precede terminal events;
immutable invocation credentials are not repaired by desktop refresh/retry.
Automatic title generation is omitted from this runtime to avoid an auxiliary
model runtime outside the root agent lifecycle.

Original owned/managed connection provenance persists in Thread metadata.
Selection, bootstrap and actual backend resolution each reject managed routes;
managed ProductSpace records cannot become locally owned. Local Skills use the
existing snapshot/project roots, while enterprise canonical Skills and UI or
cross-session capabilities receive no implicit grant.

## Consequences

An owned connection can run independently of Electron without fabricating a
personal ProductSpace. A future managed broker must implement trusted account,
space, admission/receipt/finish and revocation coordination; adding identifiers
to this bootstrap does not grant those rights. Controlled-provider evidence
proves the runtime transport and tools only; a real authenticated provider run,
independent review and formal product acceptance remain separate gates.
