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
| [python-jose GHSA-3qf3-8w2g-rqmx](https://github.com/advisories/GHSA-3qf3-8w2g-rqmx), updated October 5, 2026 | Pin 3.5.0 matches affected range. Described precondition is DER public key accepted for HMAC. Source `core/security.py` verification restricts the algorithm to HS256. Revision attribution correction: baseline `8d25f34a33242adcaab092afdb07af7956f327bd` uses a fixed source key; it does not contain configured-signing remediation. Configured signing exists only in unmerged auth PR1391 at `e161f604`, as verified by the coordinator. No production-fixed claim follows. No key value is reproduced. Exploitability is unestablished; debug signature-disabled decoder requires separate auth review. Preserve separately controlled auth work. |

This is a sampled review, not a clean bill of health. All other packages/advisories remain unassessed. Completion requires full ecosystem version matching and source reachability triage with a dated database snapshot plus the actual deployed inventory. T03 satisfied within this lane: no upgrades or new application severity counts from package presence alone.

Tracking: independent evidence record; canonical remote task lookup denied (`Forbidden`), deduplication pending with coordinator. No finding closure.

## Expanded review, 2026-11-01

The machine-readable [selected advisory register](privacy-evidence/advisory-review-20261101.json) expands the review from three to eleven primary advisories. It records exact source versions, dated official advisory links, affected-version predicates and source reachability limits. `backend/tests/test_audit9_advisory_evidence.py` verifies all eleven version predicates against the exact baseline SBOM. This supersedes the earlier three-advisory sampling scope; it remains non-exhaustive.

| Additional official advisory | Exact source/local isolated version and reachability result |
| --- | --- |
| [GHSA-2c2j-9gv5-cj73](https://github.com/advisories/GHSA-2c2j-9gv5-cj73), source dated 2025-07-21 | starlette 1.0.0; range `<0.47.2`. Affected version predicate excluded for this exact version. FastAPI runtime middleware reachable; no direct Form/UploadFile/request.form application use found; affected version excluded. |
| [GHSA-9hjg-9r4m-mvj7](https://github.com/advisories/GHSA-9hjg-9r4m-mvj7), source dated 2026-10-19 | requests 2.33.1; range `<2.32.4`. Affected version predicate excluded for this exact version. requests.get/post occur in provider search and direct market adapters; netrc behavior not inspected; affected version excluded. |
| [GHSA-777c-7fjr-54vf](https://github.com/advisories/GHSA-777c-7fjr-54vf), source dated 2026-06-12 | axios 1.16.0; range `>=1.7.0,<1.16.0`. Affected version predicate excluded for this exact version. No direct axios import/configured fetch adapter in application source; services use fetch; transitive callers unassessed. |
| [GHSA-p92q-9vqr-4j8v](https://github.com/advisories/GHSA-p92q-9vqr-4j8v), source dated 2026-06-12 | axios 1.16.0; range `>=1.0.0,<1.16.0`. Affected version predicate excluded for this exact version. No direct application axios proxy configuration or Proxy-Authorization use found; transitive Node adapters unassessed. |
| [GHSA-hfxv-24rg-xrqf](https://github.com/advisories/GHSA-hfxv-24rg-xrqf), source dated 2026-06-11 | axios 1.16.0; range `>=1.0.0,<1.16.0`. Affected version predicate excluded for this exact version. No application axios or xsrfCookieName configuration found; transitive callers unassessed. |
| [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93), source dated 2026-04-24 | postcss 8.5.14; range `<8.5.10`. Affected version predicate excluded for this exact version. Build path configured in frontend/postcss.config.mjs with @tailwindcss/postcss; affected version excluded. |
| [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), source dated 2026-07-23 | postcss 8.5.14; range `<=8.5.11`. Affected version predicate excluded for this exact version. PostCSS build path reachable; no runtime user-supplied CSS processing route found; affected version excluded. |
| [GHSA-vffw-93wf-4j4q](https://github.com/advisories/GHSA-vffw-93wf-4j4q), source dated 2026-07-15 | python-multipart 0.0.27; range `<0.0.30`. Affected version predicate matches; application exploitability unestablished. No direct Form/UploadFile/request.form application use found; framework and indirect multipart entrypoints unassessed. |

Local isolated installation confirms the listed Python versions using importlib.metadata and npm versions using installed package manifests; these are test-environment observations, not deployed package receipts. All npm occurrences of reviewed packages were compared, including nested lock paths (reviewed packages each have one locked version). Python requirements and npm lock hashes remain unchanged. No upgrades or runtime behavior changes were made.

Source checks: Requests call sites occur in `ai_providers/tools/web_search.py`, `recommendation_audit/adapters.py`, `recommendation_audit/worker.py` and `polymarket_direct/direct_polymarket.py`; framework FileResponse paths occur in Auto-Live routes. Frontend PostCSS is configured in `postcss.config.mjs` with the Tailwind plugin. Search found no direct application Axios imports, xsrfCookieName/proxy credential configuration, backend UploadFile/Form/request.form entrypoints or Next ImageResponse use. Absence of a direct source use is not proof that framework/transitive paths cannot reach affected code. No advisory proof-of-concept or hostile payload was executed.

Source/library matches for python-multipart 0.0.27 and python-jose 3.5.0 remain leads requiring owning-lane reachability review. The eleven-advisory register does not establish a complete current advisory inventory, deployed artifact contents, OS packages or transient build dependencies. T01 deployed completeness and T02 exhaustive applicability remain open; T03 is preserved.

### Bounded operator metadata comparison

A subsequent authorized operator-provided read-only backend distribution metadata receipt was compared privately using PEP 503 canonicalization (lowercase and collapse runs of hyphen/underscore/dot). All 96 source pins match exact installed versions; zero pins are missing or version-mismatched; 31 additional distributions account for the larger installed count of 127. Those additional distributions may include transitives and tooling; count difference alone establishes neither vulnerability nor drift. No application or environment imports, package changes or host calls were made by this lane. Detailed host metadata, collection paths, timestamps and service records remain outside the source repository.

The reviewed backend advisory version predicates therefore have bounded operator-metadata applicability, not just source-pin applicability. This does not attest loaded code, deployment artifact identity, immutable build provenance, OS/frontend inventory, transitive dependency graph or exhaustive advisory coverage of the 31 additional distributions. Local isolated transitive resolution is not a substitute for the supplied installed set. The existing coordinator retains the private receipt; the complete deployed-build SBOM acceptance remains open.
