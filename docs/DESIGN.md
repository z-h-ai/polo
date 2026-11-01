# Polo client design specification

The repository-maintained Polo desktop-client design system lives in the [`polo-client-design-system` skill](../.agents/skills/polo-client-design-system/SKILL.md).

Use that entrypoint for client implementation, prototypes, component changes, and UI review. It routes to the canonical foundations, page/region baselines, real component usage, and style/token references without maintaining a second copy here.

The Skill is the design SOT: its bound sources and SHA-pinned model are verified via `docs/mvp-complete-flow-hifi/tools/check_design_system.py`, and the current-implementation baseline is generated from real renderer source via its own tools. The former `polo-client-design` skill (v0.17-era specification bundle) has been removed; its confirmed decisions that remain in force are carried by `docs/client-journey-review/spec.md` and the skill's policy alignment record.
