# Design iteration and public promotion

`main specification → design worktree → prototype iteration → user confirmation → public specification → implementation → release reconciliation`

## Candidate and review

Start from the current public `main` commit in a separate worktree. Inspect repository integration instructions and preserve existing changes. Record a `design_changes` entry in [source.json](source.json): goal, scope items (pages and behaviors), common-rule changes, excluded work, affected interaction states, full baseline commit and proposed next version. Ordinary page-specific reuse needs no entry.

Edit the relevant normative references and bundled modular source/styles; regenerate full and component HTML using [html-context.md](html-context.md). Never change generated HTML alone. Show before/after artifacts at the same viewport/theme and the affected states (e.g. normal, focus, disabled, error, narrow window). Identify native/runtime limits and any checks not performed. A successful build does not confirm a design.

Target colors and dimensions go in the relevant normative section and prototype CSS. Label the target with its change ID and keep the old value labeled `observed at <release/path>`. `tokens.json` remains the deterministic extraction of the pinned Release; never extract a candidate design into it. Explicitly label intended deviations in prototype traceability rather than claiming release fidelity.

## Confirmation and versioning

`design_context.version` and prototype `baselineVersion` remain the existing design version while drafting. Each change reserves a strictly increasing `major.minor.patch` revision; on user confirmation set both existing version fields to that revision. No second version counter is introduced. Migration retains `1.0.0`, the original import/release split and a frozen target digest; it adds no retrospective confirmation or delivery claims.

After regeneration, compute the candidate fingerprint:

```bash
python3 .agents/skills/polo-client-design/scripts/design_status.py --fingerprint settings-single-column
```

This read-only command hashes the change contract plus all normative target files, prototype source, assets, scenes and exported HTML. It excludes release snapshots, workflow tools and evidence metadata. Present the exact version/artifacts to the user. Only after actual confirmation record `confirmation.by`, `at`, `reference` (conversation/task reference identifying the explicit statement), and that fingerprint; set `design_status: approved`. The tool never supplies approval. If target content or scope changes afterward, describe the delta and obtain renewed confirmation; preserve the earlier statement in task history. A further design revision after approval gets a new increasing version and entry, retaining the old confirmation; present only the changed portion for renewed approval. Do not regenerate its historical fingerprint.

A fully replaced design becomes `superseded` with `superseded_by` pointing to a later confirmed entry. Partial replacement keeps the old record and documents which scope is replaced; preserve remaining obligations. Status history and evidence remain available in Git and the task.

## Metadata contract

`source.json` schema version 2 adds `design_migration` and ordered `design_changes`. Each change contains:

| Field | Meaning |
| --- | --- |
| `id`, `goal`, `scope` | Stable unique ID, concrete goal, nonempty unique page/behavior items |
| `changes`, `out_of_scope`, `states` | Rule delta, exclusions, nonempty unique interaction states |
| `baseline_commit`, `version` | Full public starting commit; proposed/confirmed design revision |
| `design_status` | `draft / approved / superseded` |
| `delivery_status` | `pending / implemented / released`; independent of approval |
| `confirmation` | `null` for draft; user/time/reference/fingerprint for confirmed revisions |
| `implementation` | Required for implemented/released: full `commit`, evidence `reference`, complete `scope` list |
| `release_evidence` | Required for released: full `commit`, `reference`, complete `scope`, `tag`, `published_at`, `draft: false`, `prerelease: false` |
| `superseded_by` | Required for superseded: ID of a later confirmed replacement |

Use actual evidence references, never placeholder proof. Metadata validation checks evidence structure, not the truth of a user's approval, Git ancestry or runtime behavior; the operator must read the cited evidence. Partial implementation retains `pending` and records proven and remaining scope in the task/reconciliation report. If already fully implemented but only partly released, retain `implemented`. Release regressions do not erase historical implementation/release evidence.

## Public integration and adoption

Run default validation, `--for-promotion`, tool tests and Skill format validation. A structured draft can preview and pass default checks but cannot pass promotion. An approved/pending design can pass promotion. The migrated unchanged baseline can pass without invented approval. The latest active approved revision must match the current target fingerprint.

Create a standalone Skill commit and integrate it to `main` according to existing repository rules (e.g. narrow cherry-pick). Recheck the resulting content and promotion validation. Design approval does not imply push authorization; use prior explicit Git authorization when available and prepare the concrete commit before requesting anything still needed. Do not merge unrelated feature history.

Implementation tasks record the adopted design Git commit, which precisely locks content. New tasks use the public `main` specification; existing tasks retain their pin until an explicit delta comparison and adoption decision. Implementation and release evidence are added later, without holding back an approved design's public promotion.

See [settings-single-column-example.md](settings-single-column-example.md) for a worked, isolated example; it is not an approved product change.
