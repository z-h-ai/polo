---
id: cleanup.local-models
module: cleanup
type: domain
priority: 11
status: pending
estimatedMinutes: 25
dependencies: [cleanup.onboarding]
---
# Remove Local Model (Ollama) Support

## Description
Remove all local model support (Ollama and similar). Per spec §5.2, local models are no longer supported since LLM configuration is Admin-managed.

Files to find and clean up:
- Any references to Ollama, local models, or local LLM in:
  - `apps/electron/src/renderer/components/onboarding/LocalModelStep.tsx` (if not already removed by cleanup.onboarding)
  - Configuration types/enums that include local model options
  - Server-core handlers for local model detection/management
  - UI components showing local model options in model selector
  - Package dependencies (e.g., Ollama client library)

## Environment Context
- Package manager: Bun
- Test strategy: Verify build + grep for residual references
- Key concern: Local model references may be scattered across config types, UI, and server code

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| Model selector | Local models removed | Only Admin-assigned remote models shown |
| Config with local model | Legacy config | Ignored/filtered out |
| Ollama import | Dead code | Build error if reference remains |

## Acceptance Criteria
1. No references to Ollama or local models in application code
2. LocalModelStep component removed (if not already by cleanup.onboarding)
3. No "local" model option in model/provider selection UI
4. Any Ollama-related package dependencies removed from package.json
5. Build succeeds after removal

## Test Cases (Red Phase)
- TEST: `grep -ri "ollama" packages/ apps/` returns no results (excluding node_modules and test files verifying removal)
- TEST: `grep -ri "local.model\|localModel\|LocalModel" packages/ apps/` returns no results related to LLM
- TEST: `bun run typecheck` passes after removal
- TEST: Model selector does not show any "Local" or "Ollama" option
- TEST: No package.json contains Ollama-related dependencies
- TEST: `grep -r "LocalModelStep" apps/` returns no results
- TEST: Provider type enum/union does not include "ollama" or "local" variant

## Fixtures Required
- None (deletion task)
