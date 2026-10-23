> Final qualified disposition for audited `bcdfdd9a` is appended below. Earlier uncommitted/pending-CI statements are preserved historical checkpoints, not current status. No blanket dependency clearance is claimed.

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


## Final qualified development disposition — bcdfdd9a

Audited implementation `bcdfdd9a2c7c94ea0711e466b0490f2371aa9280` passed all55 CI jobs (main39709029976, baseline39709029977, API39709030061),172 Stage17 tests including7 actual PostgreSQL cases and20 Linux recovery cases, zero skips. Actual HTTP login193309 transferred/619941 decoded bytes meets unchanged194099/624438 limits. The runtime-budget repair did not change dependency locks or security/budget guards. Scoped independent source review and final ledger review bind the tested implementation; this documentation-only checkpoint does not claim CI ran for a later documentation commit.

Receipt packet: native bundle12396625697 SHA256 `5203e37aea063fea9846e4bf4e1cb526f995998d921971fa27b300d10dec0fcc`; manifest `51524e50220bb1d3d41fa1bd9c2e961f852b83b4cb584e67a05aecbf9a442e05`; application `2fc55d75fc01210b85353f83f06fa4cd8ae579a77141eb742e0c5f522905226a`; frontend `71b0943b98275df6ce9ce626fcc850a28b3a12432c652c92dddb75a8e92294d6`. Independent cloud audit inspected all125 production wheels,10966 ZIP members,10809 RECORD-verified files and25 safe entrypoints with no structural issues. Source/controller/helper/units/frontend/offline receipts are exact-head bound. These are attributed independently verified cloud results, locally reconciled through `/tmp/stage17-independent-bcdf-acceptance/ledger-final-review.json` and the task-local technical disposition ledger; this local documentation step did not repeat downloads or host tests.

| Finding/scope | Qualified disposition and remaining condition |
|---|---|
| python-jose3.5.0 / GHSA-3qf3-8w2g-rqmx; ecdsa0.19.2 / GHSA-wj6h-64fc-37mp | Current application-path nonapplicability: explicit HS256-only encode/decode, dedicated symmetric secret and no application ECDSA signing/keygen/ECDH. Google RSA verification is separate. Core security SHA256 remains `e840ce6ebcc40031288c6293b178937f9dfb9d05a8105edbca1a3c5c7cc9cef2`; retained four synthetic algorithm/key-substitution probes support this scope. Libraries remain affected; reassess before algorithms/keytypes/configuration/provider changes. No PyJWT installation or global safety claim. |
| braces3.0.3 / GHSA-vfj7-8cjw-p6xm | Remains vulnerable in dev ESLint→fast-glob→micromatch. Current trusted repository/config has no public/dynamic rootDir pattern input; unused shadcn CLI removed with exact CSS/MIT retained. Separate runtime package paths absent in audited standalone inventory. This is current release-runtime exclusion, not a patched library, clean dev tree or risk waiver. Reaudit untrusted glob/config exposure and future packaging. |
| Production-transitive pytest | py_order_utils/poly_eip712_structs require pytest unconditionally; do not dismiss it as test-only. Exact fresh artifact contains9.1.1 and the fresh OSV identity response has no matches. No app/consumer pytest imports found. Future resolutions need their own audit. |
| Local pytest8.4.2 / GHSA-6w46-j5rx-g56g | Current other-user temp-symlink prerequisite excluded by reviewer-observed UID501/private0700TMPDIR and nonsymlink0700pytest root/directories. Ordinary child pytest-current symlink is not the vulnerable root condition. No retroactive/all-version safety claim; preserve private temp boundaries. |
| Historical Mac pip24.3.1 | CPython3.13.2 PEP706 filtered branch excludes vulnerable tar fallback (GHSA-4xh5-x5gv-qwph); recorded installs were wheels. Current installed RECORD targets/27 entrypoint names are safe. Original126 Mac wheel bytes, complete index/config/redirect history and selfcheck import evidence are missing; notices show selfchecks ran. GHSA-58qw-9mgm-455v, GHSA-6vgw-5pg2-w6jp, GHSA-jp4c-xjxw-mgf9, GHSA-qwm4-qh6w-59xr and GHSA-wf93-45jw-7689 retain those historical unknowns. Fresh125 Linux input inspection certifies only its exact bytes, not missing Mac inputs. No compromise or full tooling clearance asserted. |
| Future dependency operations | HOLD until patched pip>=26.2.0 with version selfchecks disabled is available under appropriate installation authority. No upgrade performed by this recording step; pip is not bundled in the production artifact. Existing independent CI evidence is not dependent on retroactively certifying Mac installation history. |
| Advisory coverage | Fresh152 public runtime identities were OSV-scanned: only the scoped JWT libraries match; actual runtime27 npm identities have no OSV matches. Fresh npm crosscheck was DENIED/NOT RUN and was not retried. Prior b935 npm evidence is dated prior evidence only: unchanged b935/bcdf lock SHA256 `9fdf5ce8494c601808395dad0ece052764a1550769e7c2556fb03827489995b3`.108 named versionless records remain parent-package-bound provenance coverage, not independent version-level vulnerability clearance or a complete SBOM. Earlier43 absent optional Mac pairs are not declared globally safe; the current actual Linux artifact identity inventory is the acceptance scope. |

The completed technical audit supports qualified LOCAL/CI development acceptance with these explicit boundaries. It does not waive affected tooling or certify every past operation. All nine external release gates remain blocked. Real residency producer, privacy/data adapters, consumer/schedule bindings and monitoring rollout are unfinished implementation/integration work in addition to approvals. UAT2 Stage17 was not deployed, owner deployment acceptance is unclaimed, real activation is disabled and production is unchanged. Stage18 requires parent verification of the recorded development gate; no restart/spend/deployment authorization follows from this ledger.
