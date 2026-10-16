# ADR 0019: Broker managed CLI compute through the desktop

Status: Implemented candidate, 2026-10-16; independent review and real Admin/provider acceptance are separate gates.

The CLI continues to own a separate Agent/runtime and rooted Thread. The running,
signed-in desktop owns Admin session generation, current online ProductSpace,
canonical compute credentials and the existing `polo_assistant` billing outbox.
No CLI session enters the desktop session index.

Only authenticated loopback sockets without browser Origin can call the narrow
begin/attach/heartbeat/finish protocol. Begin derives account/space from the
trusted Admin coordinator and fence, validates online access and the canonical
connection, then CAS-registers a `cli_execution` under the shared switch mutex.
Thread roots come from the host configuration root. PID/birth, owner-file lease,
Thread identity and the attached runtime's parent/group relationship are verified.
The Broker never kills a client-supplied PID. Stop revokes admission, aborts the
proxy, notifies both owner/runtime and confirms the runtime and its process group
are gone. Stop failure retains the entry and prevents a successful switch/quit.

The only managed transport is the existing OpenAI chat-completions protocol.
A strict invocation credential proxy enforces Host, absent Origin, exact path,
allowlisted model and per-HTTP start/admit/observed usage/receipt/finish. Real keys
and Admin tokens stay in the desktop. A private stdin bootstrap carries a short
lease and capability to an independently attached runtime. Its explicit verified
`desktop-managed` authority disables local duplicate billing only for that exact
immutable loopback connection. Raw managed connections still fail owned admission.

Persistent Threads bind non-secret original account/ProductSpace/Admin origin.
Resume and list reauthorize the binding; cross-owner/provider histories and
unknown legacy managed ownership are refused. No source/Skill permission is
inferred from a CLI lease, and enterprise Skills are not copied as local Skills.
Owned connections remain independent of the App. Managed supervision currently
requires POSIX process groups; Windows managed execution fails closed.

Every awaited tool/event and terminal continuation binds its original managed
record, runtime token and processing generation. Revocation still permits owned
resource cleanup, while stale mutation/event/persistence continuations cannot
adopt a successor generation. An empty model termination is not CLI success;
a successful explicit tool outcome can complete without prose.

Controlled HTTP fixtures establish transport, accounting and lifecycle behavior.
They do not establish real account balances, external provider success, commercial
settlement, full native release or formal product Acceptance.
