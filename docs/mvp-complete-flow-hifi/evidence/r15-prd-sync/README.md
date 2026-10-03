# PRD synchronization — 2026-10-03

Authority: `docs/client-journey-review/spec.md`, now `master-r15-prd-sync`. The user asked to audit recent prototype changes for PRD synchronization. This revision folds the already confirmed §13.9–13.13 decisions into the feature map, entry structure, PC-F02/03/04/06/09 flows and acceptance examples. No new product policy was inferred from the mockup.

Synchronized areas: home catalog and navigation/Header; card/source presentation; browser-only circle joining; circle list/detail/subscription hierarchy; existing assistant implementation versus skill-management delta; single-confirmation automatic stopping and actual N tasks; settings copy; current versus historical prototype evidence. The closure-operation cross-reference now points to PC-F02/C-R04, rather than C-R06 desktop permissions.

The product revision remains `poo70-workbench-r15-copy-cleanup`. Only the Spec source hash/revision changes in the manifest. Both MVP/review HTML are byte-identical after replacing that embedded manifest; the assistant output and all other previously bound sources are byte-identical. Scenes, stories, aliases and operations are unchanged. Five generated outputs reproduce byte-for-byte.

`before-document-sync.tar.gz` retains the exact pre-edit Spec, manifest, product/review HTML and quality report solely for verification. It is historical evidence, not another maintained PRD. `verify_documentation_sync.py` verifies exact equivalence and updates the quality-report bindings without modifying old browser/semantic evidence. The top-level report labels their results as inherited and retains their original scope and hashes; no new behavior/semantic acceptance is claimed.

Reproduce from repository root:

```sh
python3 docs/mvp-complete-flow-hifi/tools/build_review.py
POLO_REVIEW_EVIDENCE=evidence/r15-prd-sync python3 docs/mvp-complete-flow-hifi/tools/validate_unified.py
python3 docs/mvp-complete-flow-hifi/evidence/r15-prd-sync/verify_documentation_sync.py
python3 docs/mvp-complete-flow-hifi/tools/validate_unified.py --quality-report docs/mvp-complete-flow-hifi/quality-report.json
```

This refresh leaves the other session's directory/index work untouched. No Git commit or real Electron changes were made by this task.
