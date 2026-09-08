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
