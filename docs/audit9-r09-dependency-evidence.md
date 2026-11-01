# A9-R09 — source inventory and bounded advisory review

Status: complete source-pin inventory; deployed-build completeness and exhaustive advisory assessment remain open.
Baseline: `8d25f34a33242adcaab092afdb07af7956f327bd`; review date 2026-11-01.

`docs/privacy-evidence/baseline-source.cdx.json` contains a CycloneDX 1.5 inventory with 96 Python requirements and all 932 npm lock entries, including development, optional and nested entries. Metadata includes the exact baseline SHA and SHA-256 hashes of both inputs. Each entry has a unique source reference and version. Npm lock paths preserve duplicate installed locations; no dependency graph, license verification or downloaded-artifact hash verification is claimed.

Regenerate offline from repository root:

```sh
python scripts/privacy-source-sbom.py --ref 8d25f34a33242adcaab092afdb07af7956f327bd > /tmp/baseline-source.cdx.json
cmp /tmp/baseline-source.cdx.json docs/privacy-evidence/baseline-source.cdx.json
```

Coverage verification passed: 96/96 Python pins; 932/932 non-root npm entries; unique references; byte-identical regeneration. Requirements and lockfiles were not changed. No package installation or upgrade was performed.

T01 remains incomplete for the deployed build. Python requirements are pinned but not hash locked and do not prove a complete resolved environment. `backend/Dockerfile` also installs unpinned `gunicorn[gevent]`; systemd deployment installs requirements into a pre-existing runtime. OS/base image packages, Node/Python versions, build-only dependencies and actual host packages/artifact identity need existing coordinator evidence. Source pins must not be relabelled as the deployed SBOM.

T02 bounded current primary-source review:

| Primary advisory | Source applicability and reachability assessment |
| --- | --- |
| [Next.js GHSA-vcvr-r3jv-pc5j](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j), published September 22, 2026 | Lockfile Next 16.2.5 is in affected range >=16.2.0 <16.3.6. Exploitation requires attacker-controlled SVG values in Node `next/og` ImageResponse. Source search found no `next/og` or `ImageResponse`; direct application reachability not observed. Bundled/transitive behavior remains unassessed. No application severity count inferred. |
| [Next.js GHSA-c4j6-fc7j-m34r](https://github.com/advisories/GHSA-c4j6-fc7j-m34r), updated May 14, 2026 | WebSocket SSRF affected range ends before 16.2.5; baseline lock version is listed patched. This excludes this advisory's version predicate only. |
| [python-jose GHSA-3qf3-8w2g-rqmx](https://github.com/advisories/GHSA-3qf3-8w2g-rqmx), updated October 5, 2026 | Pin 3.5.0 matches affected range. Described precondition is DER public key accepted for HMAC. Source `core/security.py` verification fixes algorithm to HS256 and uses configured secret; actual key material was deliberately not inspected. Exploitability is unestablished; debug signature-disabled decoder requires separate auth review. Preserve separately controlled auth work. |

This is a sampled review, not a clean bill of health. All other packages/advisories remain unassessed. Completion requires full ecosystem version matching and source reachability triage with a dated database snapshot plus the actual deployed inventory. T03 satisfied within this lane: no upgrades or new application severity counts from package presence alone.

Tracking: independent evidence record; canonical remote task lookup denied (`Forbidden`), deduplication pending with coordinator. No finding closure.
