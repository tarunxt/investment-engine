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

Frontend remediation is unfinished. Official npm 12.2.0 was downloaded into a task-local folder and SHA-512 integrity matched official registry metadata. Canonical lock regeneration stopped at EALLOWREMOTE for the official Tailwind oxide WASI tarball; no fetch policy was relaxed, no lockfile was fabricated and no frontend package installation/build is claimed. The proposed manifest is preserved as local evidence rather than committed with a mismatched old lock. Available disk space is also limited. Dependency audit completion, independent review, fresh full CI/artifact/offline evidence and the development ledger gate remain required before Stage18. Provider/legal/privacy/operational launch approvals and deployment acceptance remain separate and unclaimed.
