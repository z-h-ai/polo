# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Phone number sign-in and account security** — Sign in or automatically create an account with a mainland China phone verification code, discover the deployed browser challenge securely, keep phone number or username password login, and set a password later from Account Security. (POO-8) (`ead3632`, `86523bb`)
- **Local App Bundle runtime** — Install checksum-verified static, Python, and Bun app bundles into isolated version directories, launch them with a minimal credential-free environment, wait for localhost health checks before launch, manage bounded logs and process trees, and preserve user data across updates and last-known-good rollback. (POO-12) (`fb69d76`, `92b4aef`)
- **Organization onboarding and switching** — Create a business workspace or creator space after sign-in, resume invitation links through authentication, switch organizations without leaking organization-scoped state, and let Owners and Managers manage members and invitations according to their role. (POO-13) (`56ce30d`)

## Improvements

- **Unified Polo terminal command** — Desktop releases now include a version-matched CLI, packaged headless server, and Bun runtime behind the cross-platform `polo` command. The CLI discovers a running App securely, `polo run` works without a source checkout, and macOS can install, repair, or remove terminal support from the App. (POO-14) (`cd05b2d`)

## Bug Fixes

- **Terminal packaging and upgrade safety** — Keep the macOS command attached to the current App bundle across moves and upgrades, preserve modified or user-owned Windows and Linux launchers with verified ownership state, and use the same self-relative packaged wrapper on every platform. Linux launcher, ownership state, PATH profile, and App replacement now commit with revalidation and rollback, while immutable previous-release tags use strict SemVer validation. Shell readiness checks are bounded, normal builds are gated on final-container smoke tests, and the three-platform release/nightly workflow verifies fixed previous assets before installing build tools, then runs install, discovery, real headless tasks, upgrade, and uninstall checks. Legacy releases are validated with their historical layout, packaged runtimes include checksum- and architecture-verified `uv`, release acceptance requires pinned signing identities, and terminal/discovery failures are localized. (POO-14) (`7a5f553`, `233ada3`, `b4c14f9`, `cb18105`, `4ca546d`, `beb25e2`, `cabb49d`, `80d3f3f`, `55a1b60`, `eeae32c`, `40f4c7b`, `d1753a0`, `7a026f3`)

## Breaking Changes
