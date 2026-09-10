# Publishing Bullpen event clusters

Edit `frontend/data/bullpen-event-clusters.json` in GitHub and deploy `main`.
Paste a raw JSON array with string `event_name`, `market_id`, and `cluster_id`
fields. Use exact source names and IDs. Each market must appear once. Validate
with `cd frontend && node --test tests/bullpen-event-clusters.test.mjs`.

The deployed file is the shared default in every browser. The current file
contains the 58 classified events and 20 clusters reviewed on September 8, 2026.
It is a reviewed snapshot, not automatic classification of newly appearing events.

The Add Cluster json popup and inline edits remain browser-local overrides.
Publishing changed JSON supersedes overrides from older mappings. Old storage
is left intact, but does not hide the newly published assignments. Deployments
that do not change the mapping preserve current overrides. Invalid browser
storage falls back to the published mapping with a visible error.

These are display assignments only. They do not change trading stages, audit
snapshots, eligibility, ranking formulas, or order execution.

### Claim estimates

Each row may also contain `claim_date`, an ISO 8601 timestamp with explicit
`Z` or offset (example `2026-09-12T18:00:00+05:30`), or null when no defensible
estimate is available. The History **Claim date** column immediately follows
Deadline and uses its IST date/time formatter. This is estimated redeem
availability, not simply event expiry. History Returns/day and cluster ranking
use fractional time to this estimate; the formula popup explains missing/stale
estimates. Legacy rows without the field continue to import, showing no estimate.

The Update Stage 1 Clusters automation must generate this fourth field for each
classified market, research the market's specific resolution rules and oracle
state, and publish it together with the cluster mapping. Keep per-market
research time, source URLs, uncertainty and rationale in clustering metadata;
never treat a high trading probability or a request timestamp as proof of payout.
Validate with `node --test tests/bullpen-event-clusters.test.mjs tests/bullpen-claim-returns.test.mjs`.
