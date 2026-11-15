# STATE-Runs-List-LoadingEmpty

Verified 2026-11-01 UTC against fetched origin/main 8212f9e93772a8f5a91f3f782640aeeff0fe7cc8.

The actual RunsPage and workflow cards are bundled with synthetic API and Next navigation adapters. No production requests, jobs, providers or stored records are touched. Desktop screenshots use 1440px and deviceScaleFactor 1 (100%); narrow screenshots use 390px. Saved PNGs were visually inspected (desktop initial loading, narrow retained refresh, desktop partial) and readback.json was read after saving.

Fixtures: cold unresolved reads, successful empty, populated completed, failed reads, partial result semantics, and retained populated refresh. The 18-test history suite additionally checks out-of-order superseded responses and partial independent-source delivery. Browser checks cover keyboard selection and retained focus during response publication, retained category, no horizontal overflow, Back URL/category restoration, and zero external requests or browser errors.

Validation: node --test tests/runs-history-loading.test.mjs (18 pass, 0 fail/skipped); node scripts/runs-list-loading-empty-playwright.mjs (1 scenario suite pass, 0 fail); npx tsc --noEmit (pass); git diff --check (pass). Full production build and live deployment were not run; only the batch integrator may merge/deploy. Back checks use an isolated browser history/navigation adapter, not a live authenticated Next app. No latency benchmark is claimed. The installed Next package's requested dist/docs directory contains no guide files.
