# A9-R09 — bounded source applicability and regression plan

Source reviewed: `3800e13dd0c2e5597e8b855569b4bf968e384740`, 2026-11-01. Installed library files below are read-only local test dependencies corresponding to the source lock/pins; they do not attest deployed modules or native binaries. No native module was loaded, image decoded, hostile request sent, dependency changed or security policy altered.

## Optimized images: supported path, constrained origins, unknown codec reachability

Application `frontend/next.config.ts:55-73` has no image configuration override. `components/shared/MarkdownRenderer.tsx:298-310` passes string content-derived `src` to Next Image; `components/dashboard/UserMenu.tsx:89-94` passes `user.avatar`; neither sets unoptimized. These show an optimizer source path, not proof that supplied sources are accepted.

Local Next 16.2.5 sources:

* `node_modules/next/dist/shared/lib/image-config.js:55-73`: domains/remotePatterns empty, localPatterns undefined, dangerouslyAllowSVG false, dangerouslyAllowLocalIP false, unoptimized false; output format defaults to WebP.
* `match-local-pattern.js:37-43`: undefined localPatterns permits local image paths. `match-remote-pattern.js:59-60`: a remote URL needs an allowed domain/pattern. `server/image-optimizer.js:553-600` rejects oversized/protocol-relative/recursive URLs, restricts absolute protocols to HTTP(S) and checks those patterns. Thus the inspected defaults do not admit arbitrary remote image origins; broad CSP img-src does not override optimizer validation.
* `image-optimizer.js:342-373` recognizes common SVG/AVIF signatures. `:468-488` may invoke `sharp(buffer).metadata()` when other detection fails. `:1075-1094` detects content before rejecting SVG. Consequently dangerouslyAllowSVG=false does not prove native metadata parsing is unreachable for every SVG-like input. WebP output negotiation is not an input-codec restriction; AVIF has an explicit detection branch and no analogous SVG-denial branch here.
* `node_modules/sharp/lib/sharp.js:8-27` selects a platform/native or WASM module at runtime. Lock optional packages and local trace membership do not establish which binary/codecs/libc the deployed service loads. No native/platform probe was performed. No application API source returning image content was found in the bounded frontend API scan; local static/internal routes and their accepted bytes still need an owner inventory.

Credible version-matched candidates: Next 16.2.5 / sharp 0.34.5, including GHSA-2464-fhr4-w9xw and GHSA-2xp9-vwfh-vxw4. Native exploitability and attacker supply of an accepted local image remain unestablished. Official published candidates are Next 16.4.1 with sharp >=0.35.5 for the reviewed SVG issue and Next 16.3.3 for the reviewed AVIF issue. Those versions are not asserted to fix every advisory or to be a compatible application upgrade.

Smallest remediation PLAN: have the dependency owner choose a tested, compatible Next/sharp pair covering the current advisory union, preserving existing image behavior and origin configuration. Do not patch vendored Next or silently enable remote/SVG inputs. If a temporary optimization bypass or narrower local image policy is proposed instead, treat its visual/performance/input changes as a separately reviewed choice; no such policy change is necessary merely to complete evidence gathering.

Synthetic regression PLAN: exercise the actual URL validator with same-origin static/internal paths, remote denied hosts, protocol-relative and recursive paths; capture fetch calls with stubs. Test normal PNG/JPEG rendering and current avatar/markdown behavior using inert fixtures. With sharp replaced by a stub, verify detection/metadata call ordering and SVG/AVIF rejection/acceptance behavior without loading any native library or using exploit files. A later approved dependency candidate should retain those expectations and pass isolated build/browser coverage before release. Production/native evidence must come through the existing coordinator/operator if separately authorized.

## Auth.js getToken: all three application callsites have outer boundaries

`@auth/core` 0.41.2 `node_modules/@auth/core/jwt.js:89-107` reads cookies first and calls decodeURIComponent on a Bearer value at line 95 before its internal decode catch at 103. This supports GHSA-xmf8-cvqr-rfgj's malformed-header throw condition; a valid cookie takes precedence over the Bearer fallback.

Complete application callsite search found three:

* `app/api/bullpen-ai/_lib/serverBackendSession.ts:91-102`: await getToken is caught; token remains null, and lines 104-122 return null token fields. `app/backend-api/[...path]/route.ts:517-529` denies protected requests lacking both tokens with 401 before transport.
* `proxy.ts:59-63`: returned promise is awaited within the outer catch at 105-109; lines 112-121 redirect an unauthenticated protected page to login. Auth-route rendering is intentionally allowed without a token.
* `lib/databaseViewerRoute.ts:14-19`: readSession returns getToken. Its awaited invocation is inside `lib/databaseViewerOwner.ts:12-28`; rejection is caught and returns no-store 503 before proxy access.

No uncaught application getToken boundary or authentication bypass was established in these three paths. The caught errors are logged in the first two paths; no claim of universally sanitized Next logs follows. Smallest remediation PLAN: no additional catch/behavior rewrite is supported by this evidence. The dependency/auth owner may select a compatible advisory-fixed candidate under existing holds, keeping the current fail-closed semantics and secure-cookie handling; no signing/configuration change belongs in this task.

Synthetic regression PLAN: use an inert malformed-percent Bearer string with no session cookie to trigger the real library's early throw, then verify each actual caller's boundary: null context and BFF 401 with zero backend calls; protected-page login redirect; database no-store 503 with zero viewer/backend calls. Also cover valid-cookie precedence over malformed Bearer, invalid/expired cookie rejection, valid secure/chunked cookies and safe diagnostic output. These are plans, not newly executed probes or assertions.

## Forms/parsers: framework path exists, application entrypoint unobserved

Static AST parsing of all 342 backend application Python files found no imports of Form, File, UploadFile, OAuth2PasswordRequestForm/Strict, StaticFiles or HTTPEndpoint, including aliases. Text scanning found no direct application request.form/parse_form/QuerystringParser/MultipartParser calls. No application was imported or started to obtain that result.

In local FastAPI 0.136.1, `fastapi/routing.py:371,404-407` invokes request.form only for a Form body field. Starlette 1.0.0 `requests.py:278-297` dispatches request.form to multipart or urlencoded parsing. `formparsers.py:95` uses python_multipart.QuerystringParser; `:251` uses MultipartParser. Dependency presence alone therefore does not establish a reached application parser. Framework-generated/mounted/dynamically configured entrypoints remain unassessed.

Frontend Auth.js's form handling is a separate JavaScript path: `node_modules/@auth/core/lib/utils/web.js:10-15` uses req.json or URLSearchParams(await req.text), not Python multipart. Its existence does not connect NextAuth callbacks to the Python parser.

Keep python-multipart 0.0.27's GHSA-v9pg-7xvm-68hf (listed fix 0.0.31), GHSA-5rvq-cxj2-64vf / GHSA-6jv3-5f52-599m (0.0.30), and manually verified GHSA-vffw-93wf-4j4q (0.0.30). The last remains missing from the automated PyPI release response; absence from that response is not a dismissal. Starlette's form-size advisory GHSA-82w8-qh3p-5jfq similarly requires the affected form path, not merely JSON endpoints.

Smallest remediation PLAN: do not rewrite JSON endpoints or add untested global body limits solely for this unobserved precondition. Have the owning dependency lane choose a compatible parser/framework candidate covering the advisory union if an update is approved. Before adding any future form endpoint, explicitly define field/body bounds and duplicate/extended-parameter behavior.

Synthetic regression PLAN: on an isolated FastAPI fixture, assert ordinary JSON requests do not instantiate form parsers, including unsupported-content-type rejection. Separately exercise a deliberately test-only Form endpoint using tiny inert urlencoded/multipart samples with parser-call counters, duplicate/extended parameter cases and bounded negative-length/field-limit checks; no large/timing payloads or external dispatch. This distinguishes dependency behavior from application reachability without native or production tests.

All publication, auth, deployment and financial holds remain. Baseline `8d25f34a33242adcaab092afdb07af7956f327bd` is the fixed-source-key revision; configured signing exists only in held unmerged PR1391 `e161f604`. No package or application remediation is claimed implemented by this plan, and no severity count is added.

## Executed unchanged-behavior synthetic boundary regressions

Implemented as separate test files against application source `a775fe4746c55cd7538233add1c3a52c2f503b13`; no application route, catch, parser or configuration was changed.

`node --test frontend/tests/audit9-auth-catch-boundaries.test.mjs` — exit 0, **19 passed, 0 failed/skipped** (Node 24.19.0, TypeScript 5.9.3, installed @auth/core 0.41.2 and next-auth 5.0.0-beta.31). The suite runs the actual three caller bodies and relevant cookie/owner helpers, transpiled with explicit synthetic dependency injection. JWT encoding/decoding and the malformed-percent throw use the installed libraries. Application auth configuration is not imported; secret resolution, backend transport, viewer and refresh/session-update dependencies are synthetic or forbidden.

One test verifies the installed getToken early URIError. Six cases then exercise each boundary: malformed Bearer without a cookie; invalid secure chunks; expired secure chunks; valid secure cookie plus malformed Bearer; valid secure chunks plus malformed Bearer; valid plain cookie. Context/BFF denial returns null tokens/401 and zero transport calls; protected-page denial redirects to login; database malformed-header denial returns no-store 503 and invalid/expired-session denial returns 401 before backend/viewer access. Allowed database cases perform exactly one mocked identity check and viewer call. Valid-cookie precedence and reversed-order chunk assembly succeed. No rejected case dispatches downstream. These are isolated caller/library regressions, not native-browser or production identity tests.

`env -i PATH=/tmp/privacy-audit-venv/bin:/usr/bin:/bin PYTHONPATH=backend python -m pytest -q backend/tests/test_audit9_parser_boundaries.py` — exit 0, **12 passed, 2 strict xfailed, 0 skipped**, using Python 3.12 / pytest 9.2.0 / FastAPI 0.136.1 / Starlette 1.0.0 / python-multipart 0.0.27. Fixture socket connects are forbidden and checked unused. Provider telemetry persistence is disabled by the existing conftest.

Five JSON fixture cases check application/json and +json acceptance, and urlencoded/plain/multipart rejection without request.form, QuerystringParser or MultipartParser invocation. Three deliberately test-only Form cases prove actual parser execution plus an eight-character schema bound. Three tiny multipart cases prove one-field/eight-byte limits. One tiny duplicate-urlencoded case records preserved parameter order. Two expected failures assert that urlencoded parsing should honor max_fields/max_part_size; the current library ignores both even for two fields or nine characters. Those fixtures establish the reviewed Starlette library behavior, not a new application endpoint or production-exploit conclusion. Each xfail is restricted to AssertionError with strict XPASS handling; it is not a passing limit guarantee.

New xfail node IDs: `test_urlencoded_test_only_limits_must_be_enforced[first=a&second=b]` and `test_urlencoded_test_only_limits_must_be_enforced[value=123456789]`, in `backend/tests/test_audit9_parser_boundaries.py`. Existing Pytest/AnyIO and crypt deprecation warnings remain. Node syntax checks, Python compile checks and git whitespace checks passed. The earlier full suites were not rerun because application code/dependencies did not change.

Unresolved preconditions remain: dynamically mounted/generated production form paths, native/deployed image codec and input provenance, unreviewed Auth.js internal callers and runtime configuration. Known omitted multipart advisory GHSA-vffw-93wf-4j4q remains tracked. Fixed-key baseline versus held PR1391 attribution above remains intact. No package installation, upgrade, network/provider request, production probe, policy change or publication occurred in this test pass.
