---
id: polo-client.pending-usage
title: "Create pending_usage JSONL store"
module: polo-client
priority: 11
estimatedMinutes: 25
depends: []
status: completed
spec_ref: "spec-polo-ai.md §6.2 (Pending Usage Store)"
startedAt: 2026-06-05T19:22:11.814Z
completedAt: 2026-06-05T19:27:08.805Z
---
# Create pending_usage JSONL store


## Objective

Implement a local JSONL-file-backed queue for usage reports that have not yet been successfully sent to Admin API. Entries are counted against quota locally to prevent overspend.

## Acceptance Criteria

### AC1: add(entry)
- TEST: `store.add(entry)` appends a JSON line to `~/.polo-ai/pending-usage.jsonl`
- TEST: Entry is immediately available in memory via `getPendingEntries()`
- TEST: Entry has fields: requestId, userId, userJwt, sessionId, model, inputTokens, outputTokens, createdAt, retryCount=0
- TEST: File survives process restart (flushed to disk)

### AC2: remove(requestId)
- TEST: `store.remove("req-1")` removes entry from memory and rewrites JSONL file
- TEST: Removed entry no longer in `getPendingEntries()`
- TEST: `store.remove("nonexistent")` does not throw

### AC3: getPendingTokens(userId)
- TEST: Returns sum of `(inputTokens + outputTokens)` for all pending entries of that userId
- TEST: userId with no entries → returns 0
- TEST: 3 entries for user-a with tokens [100+200, 300+400, 500+600] → returns 2100

### AC4: markRetry(requestId)
- TEST: `store.markRetry("req-1")` increments `retryCount` for the entry
- TEST: Updated in both memory and disk

### AC5: getPendingEntries()
- TEST: Returns all entries as an array
- TEST: Empty store → returns `[]`

### AC6: Startup loading
- TEST: On init, loads all entries from JSONL file into memory
- TEST: Missing JSONL file → starts empty (no error)
- TEST: Empty JSONL file → starts empty
- TEST: Corrupted JSONL line → skips that line, logs warning, loads valid lines

## Boundary Matrix

| Operation | Input | Output |
|-----------|-------|--------|
| add | valid entry | appended to file + memory |
| add | entry with same requestId | overwrites (dedup) |
| remove | existing requestId | removed from file + memory |
| remove | nonexistent requestId | no-op |
| getPendingTokens | userId with 0 entries | 0 |
| getPendingTokens | userId with N entries | sum of all tokens |
| init | missing file | empty store |
| init | corrupted file | skip bad lines |

## Environment Context

- **Runtime**: Bun
- **File to create**: `packages/shared/src/admin-api/pending-usage.ts`
- **Storage**: `~/.polo-ai/pending-usage.jsonl`
- **Test file**: `packages/shared/src/admin-api/__tests__/pending-usage.test.ts`
- **Test runner**: `bun test`

## Implementation Notes

- JSONL format: one JSON object per line, newline-terminated
- Use `Bun.file().text()` for read, `Bun.write()` for full rewrite, `appendFileSync` for add
- Internal storage: `Map<string, PendingUsageEntry>` keyed by requestId for O(1) lookups
- Export singleton instance + factory function for testing with custom file paths
- For remove/markRetry: rewrite entire file (acceptable for MVP — file is small)
- `userJwt` is stored per entry so background retries can authenticate after restart. JWT has 24h TTL — entries older than that will fail with 401 and be preserved for manual resolution.
