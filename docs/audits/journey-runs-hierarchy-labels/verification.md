# JOURNEY-RUNS-HIERARCHY-LABELS

Started 2026-11-01 at approximately 04:15 UTC. Implementation against fetched main `c7d4942e03a3d0be320195b11fbbf24c5e83b94c`; the requirement was still present. Source finding supplied by the parent from its verified page 16 transcription; these screenshots are synthetic offline fixtures, not PDF or production screenshots.

Workflow cards now name the workflow scope; diagnostic child links name the stage using recorded stage/run associations, followed by the retained run ID, state and provider-job count. Unavailable associations are stated explicitly. A shared help line describes workflow → stage run → provider job. Workflow and stage detail views have All runs / workflow breadcrumbs; provider output headers retain job and stage IDs. Existing routes, calculations, execution/partial distinctions, prompts and outputs are preserved.

Safe checks:

- `node --test tests/runs-hierarchy-labels.test.mjs tests/auto-rebalance-history.test.mjs`: 5 passed.
- `npx tsc --noEmit`: passed.
- Focused ESLint on all six changed frontend source/test/script files: passed.
- `node scripts/runs-hierarchy-offline-playwright.mjs`: passed. Production components with local API/navigation/WebSocket fixtures; external requests blocked and zero attempted. 1440px and 390px at default device scale/100% zoom; link readback, focus, tab/back restoration, no card overflow, completed/failed/partial records, empty and loading stage links, workflow/stage breadcrumbs and provider IDs.
- `git diff --check`: passed.

Before/after PNGs are baseline/current component renders using the same partial fixture and CSS. `readback.json` records actual visible labels and hrefs. Workflow and stage detail narrow screenshots are also included. Images were visually inspected for wrapping and readable hierarchy.

No paid jobs, provider refresh, trading, account changes or external messages were triggered. Loading/empty checks apply to link availability; no fabricated workflow history is presented as production data. Production QA and deployment remain with the parent integration task. No dialog behavior was changed. Potential shared-file overlap: RunDetailPageContent.tsx and AutoRebalanceHistoryClient.tsx; apply narrowly during serial integration.
