---
status: accepted
---

# Allow inert reference files without an extension allowlist

Creator Skill references may use any file extension, including scripts and source code, because templates and supporting material cannot be described by a durable extension allowlist. Polo treats them as inert content: it never automatically opens, renders, or executes them, removes executable modes during installation, and still rejects executable binaries, archive links, special files, and nested archives; any later AI-requested execution remains subject to normal tool permission handling.
