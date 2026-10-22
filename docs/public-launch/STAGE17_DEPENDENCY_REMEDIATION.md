# Stage 17 dependency remediation — 21 October 2026

Status: **partial remediation; development acceptance remains pending**.

The dated audit of accepted source e1067b3 flagged 41 package/version pairs. This does not mean every advisory is exploitable through the application. The twelve backend changes below address advisory-bearing versions; existing fixed HS256 JWT restrictions and external release gates remain unchanged.

| Package | Previous | Proposed |
| --- | --- | --- |
| anyio | 4.13.0 | 4.14.2 |
| certifi | 2026.4.22 | 2026.10.19 |
| cryptography | 48.0.0 | 50.0.0 |
| httplib2 | 0.31.2 | 0.32.0 |
| idna | 3.13 | 3.15 |
| Mako | 1.3.12 | 1.4.2 |
| oauthlib | 3.3.1 | 4.0.0 |
| pyasn1 | 0.6.3 | 0.6.4 |
| pydantic-settings | 2.14.0 | 2.14.2 |
| python-multipart | 0.0.27 | 0.0.31 |
| starlette | 1.0.0 | 1.3.1 |
| urllib3 | 2.7.0 | 2.8.0 |

The approved isolated macOS CPython 3.13 environment resolved and installed the complete backend pins plus existing test dependencies from official PyPI binary wheels; `pip check` passed. No compiler, global installation or production change occurred. FastAPI remains 0.136.1. Linux CPython 3.12/native validation requires new exact-source CI rather than reuse of pre-remediation artifacts.

Seven new regressions enforce malformed-Host path integrity, URL-encoded field/part limits and readability of a public synthetic ciphertext generated with cryptography 48.0.0, while rejecting an unavailable key version. The six HTTP regressions fail in the old environment and pass in the upgraded environment; frozen-ciphertext compatibility passes in both. The dedicated Stage17 CI suite includes these seven tests and requires 172 cases with zero skips, preserving its seven PostgreSQL cases and all historical gates.

The installed-environment OSV rescan at 21:56 UTC queried 128 public package identities. None of the twelve updated packages returned advisory matches. Remaining matches are python-jose 3.5.0 and ecdsa 0.19.2, plus environment tools pip 24.3.1 and pytest 8.4.2. No-match results are not proof of vulnerability absence. JWT findings remain open for explicit applicability/remediation review; no PyJWT replacement is installed or authorized by this patch. Tool advisories require applicability triage and must not be silently omitted because they are outside application pins.

## Frontend correction — 22 October 2026

Official npm 12.2.0 was downloaded task-locally with SHA-512 integrity matching official registry metadata. The initial lock-only regeneration stopped at EALLOWREMOTE for a bundled Tailwind WASI dependency. Read-only inspection established that normal registry-mediated installation has the intended same-origin validation that this lock-only extraction path lacks. No npm code or fetch policy was changed.

At 00:55:30 UTC, measured free space was 3.46 GiB. The approved normal npm update then installed 835 packages into this worktree's own node_modules, with install scripts disabled, empty task-local user/global configs and the official registry. It did not modify the old shared node_modules symlink chain. The canonical manifest/lock correction resolves Next 16.3.8, sharp 0.35.5, PostCSS 8.5.31, nanoid 3.3.20, baseline-browser-mapping 2.11.30 and source-map-js 1.2.2. Next was deliberately returned from the initial range-selected 16.4.2 to the reviewed 16.3.8 floor before final validation. Other targeted advisory-bearing transitive packages were updated within their declared ranges; the lock diff is the canonical npm result, not a fabricated inventory.

Against Next 16.3.8, the existing 393 configured frontend regressions passed with zero skips. TypeScript, the production webpack build and postbuild runtime-artifact repair passed. Eight additional CI regressions verify all installed/locked corrected floors, official registry/integrity provenance and an actual synthetic native sharp image roundtrip. Local validation uses Node 24.19.0 on macOS; Linux packaging and exact successor CI remain separate gates.

The first fresh OSV/npm rescan did not execute: automatic approval review rejected a script that lacked proof that every outgoing package identity was public. After scope reconciliation, offline provenance checks admitted only identities proved by retained official registry responses marked public, with no authentication/cookie request headers and matching published name/version and lock integrity. The one authorized allowlisted retry queried 820 of 881 unique pairs on 22 October at 01:04 UTC. Both OSV and npm flagged only braces 3.0.3 in that subset. The 61 unproven pairs were omitted rather than transmitted; 18 corresponding lock paths exist locally, while 43 are absent optional packages. All omitted identities and proof/response digests remain in local evidence. This is partial coverage, not a clean whole-tree audit. Bundled/versionless frontend code also still requires final artifact coverage. Existing JWT and tool findings are not waived. No alternate transmission route or fetch-policy override was used.

The local five-file commit was rejected by automatic approval review, which cited the earlier read-only restriction. One scope-reconciled retry was also rejected because the reviewer required explicit approval for the exact commit and revocation of that restriction. Neither command executed, no further commit retry was attempted, and source remains an uncommitted five-file correction over b625f32b. Both denials are preserved alongside the source/archive hashes for independent review.

## Braces disposition after the preserved 38673921 checkpoint

The five-file correction was subsequently saved as 38673921 only after new explicit exact-file approval. Further dependency investigation is a separate local correction, not part of that committed approval or a public release.

Official current metadata still reports braces 3.0.3, micromatch 4.0.8, fast-glob 3.3.3 and Next ESLint plugin 16.4.2 retaining fast-glob 3.3.1. No compatible fixed upstream braces version was established; an API-incompatible replacement was not forced through an override. The cited high-severity stack-exhaustion advisory remains open.

The only application use of the shadcn CLI package was its 1,669-byte Tailwind stylesheet. That exact stylesheet is now local at app/vendor/shadcn-tailwind.css with its MIT permission notice and upstream attribution. Its body SHA-256 remains 146941ac3ff65496fdf1cb306e697255328e4dadc7c105d66e36bb031b00f6d6. The global import points to it, and canonical npm removal of the unused CLI removed 260 packages without replacing the glob API or changing fetch policy. The remaining braces/micromatch/fast-glob path is through the development-only Next ESLint plugin; all three lock records are now marked dev. No ESLint rules were disabled. The existing configuration does not supply a dynamic Next rootDir glob. This is exposure reduction, not a library vulnerability repair or waiver of development-tool risk.

The corrected graph passes 403 configured frontend tests with zero skips, TypeScript, the production webpack build and postbuild repair. Ten focused dependency tests include byte-for-byte stylesheet/licence preservation, development-only placement and an actual synthetic sharp roundtrip. Eighty-nine local production trace files contain no references to the separate braces/micromatch/fast-glob/shadcn packages; this does not prove absence of equivalent bundled code or certify a future Linux artifact.

The current public-only scan covers 604 of 647 unique pairs, with only braces flagged by both OSV and npm. Fifteen of the reviewer's eighteen newly proven pairs remain and were scanned; three were removed with the CLI graph. All 43 omitted pairs are absent optional platform packages, whose published identities and target-specific Linux artifact versions still need coverage. Bundled/versionless frontend code, the final native payload, JWT findings and tool/dependency findings including transitive pytest must still be assessed. In particular, a clean prior Linux pytest resolution is not proof about the local older test environment or a future build.

This further correction adds a local stylesheet and changes its import, exceeding the prior five-file commit boundary. No further commit or publication was attempted. Independent review, any required expanded commit authorization, fresh exact-head CI/artifact/offline verification and explicit disposition of remaining advisory risk are required. Stage17 is incomplete and Stage18 remains queued.

Dependency audit completion, independent review, fresh full CI/artifact/offline evidence and the development ledger gate remain required before Stage18. Provider/legal/privacy/operational launch approvals and deployment acceptance remain separate and unclaimed. No publication of this frontend correction, deployment, UAT2 restart, cleanup or live integration occurred during local validation.
