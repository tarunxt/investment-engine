# Sports Rankings repository

Phase 1 is an authenticated reference repository, independent of Bullpen execution.
It does not change trading decisions, filters, probabilities or existing audit snapshots.

## Coverage

The seed imported on 14 September 2026 contains 346 event rows, 75 URL prefixes,
95 competition/stage entries and 388 participant-name memberships. Every input
title and slug is preserved in catalogue.json. Competition mappings remain inferred.
88 relevant codes were checked against Polymarket's public `/sports` registry on
14 September 2026 and are stored in polymarket_codes.json. A prefix may identify multiple tournaments.
Question/slug disagreements require review; the importer does not silently fix them.

The seed is no longer the participant ceiling. Every completed Universal
Polymarket Scan now writes a compact, competition-prefix-scoped participant and
event index beside its immutable export. Authenticated Sports Rankings reads merge
that user's latest index into the seed catalogue, so newly listed teams in `uel`,
`lal`, and every other scanned sports prefix appear without a manual catalogue
release. A scan can also add a newly observed tournament prefix when its parent
event supplies a recognized sport tag; unsupported/unknown sport labels are not
guessed. The index accepts explicit parent-event `Team A vs Team B` titles and the
date-specific `Will Team win on YYYY-MM-DD?` moneyline form; draws, generic outcomes
and tournament outrights are not imported as teams. A worker-start backfill builds
the index for the latest successful scan created before this feature was deployed.

The expanded master contains all 123 user-requested sport/discipline entries,
including golf match play, with 226 ranking/competition lists. `master_sports.txt`
stores stable INTERNAL sport IDs, category, ranking scope and a reference page.
These IDs must not be treated as Polymarket codes. Reference-only entries expose
no fabricated team names, ranks or points; a reference may be a competition results
hub where no universal ranking exists. Combat divisions, doubles/pair/player,
gender, age, chess time controls and esports game titles are separate scopes.

Only explicitly configured adapters ingest public pages. Other references
(including Flashscore, ATP, ITF, GosuGamers and Liquipedia) are navigation links.
Senior WTA or FIFA standings are not substituted for juniors or women's U20 events.
Arena of Glory is retained under the imported game label pending classification review.

## Connected free datasets

* Valve's public CS2 global standings repository: official game-wide rank and points.
  https://github.com/ValveSoftware/counter-strike_regional_standings
* Football-Data's downloadable CSV results for E0, E1, D1, D2, I1, I2, SP1,
  SP2, F1, N1, B1, P1, T1 and G1: a **derived results table**, not official rank.
  https://www.football-data.co.uk/data.php
  The publisher offers computer-ready results freely for analysis. Attribution
  and exact dataset links are exposed in the page. Odds columns are not stored.
* ESPN NBA/WNBA/NFL/MLB records: derived group order by win percentage. Never uses
  projected playoff seeds as actual rank. Empty preseason standings fall back to
  an explicitly labelled previous season; no unlabelled historical substitution.
* Official NHL league positions, season and snapshot date.
* World Rugby men's/women's union rankings (distinct sources).
* ESPN-published ATP/WTA senior singles lists (150 players at verification).
* WTA public individual doubles list (50 players at verification), not pair ranks.
* FIDE standard/rapid/blitz open/women's top 100 lists (six distinct sources).
* World Netball national-team ranking, points and rating.
* FIH outdoor/indoor public men's lists. Women's positions are not inferred.
* UFC division adapter rejects conflicting duplicate lists. The public page
  contained inconsistent duplicate rankings at verification; this feed must show
  failed until the publisher supplies an unambiguous list. ESPN's alternate MMA
  endpoint was not adopted because its undated data appeared obsolete.

There are 35 configured sources, including the original 15. Nineteen of the 20
new adapters passed live retrieval/parser checks on 14 September 2026; UFC was
rejected as described above. ICC and BWF pages rejected automated retrieval;
they remain reference-only. Inclusion in the master is not numeric-data coverage.

Football calculation: 3 points per win, 1 per draw; points descending, goal
difference descending, goals scored descending. Equal scores share a rank.
Deductions, head-to-head rules, playoffs and official tie-breaks are not modelled.
The current July-to-June season is requested; there is no silent previous-season fallback.
Only teams represented in completed matches can be included in that table.

## Refresh and reliability

The 14 September outage was caused by host memory exhaustion and PostgreSQL
remaining in an OOM-triggered shutdown, rather than a ranking-feed parser.
Ranking reads have a separate proxy circuit and bounded transient retries;
loaded rows remain visible during refresh errors. A failed initial load is not
reported as an empty repository. Database shutdown/connection errors return a
retryable 503 without exposing driver details. See the runtime recovery policy
and the bounded legacy trend overlay in `docs/bullpen-run-audit.md`.

Celery Beat dispatches every 15 minutes, independently of open browser tabs.
Each source runs separately on the existing ai worker queue with 70/80-second
soft/hard limits, two retries and backoff. PostgreSQL row locks prevent overlapping
writes. Successful datasets replace the complete source snapshot atomically;
failures retain the previous rows and expose the error and success timestamp.
Unchanged normalized datasets do not rewrite ranking payloads. HTTP responses
are size/time bounded; source URLs come only from a fixed provider allowlist.
All tasks log failures. No AI calls, subscriptions or API keys are required.
Worker startup also queues an initial refresh, with a shared five-minute Redis
cooldown. Validated HTML sources allow same-host HTTPS redirects only, up to
three hops and 8 MB. Publication dates absent from the source remain null;
retrieval time is never presented as the publication date.

Manual refresh enqueues one supported source, with a shared one-minute Redis
cooldown. Page data is re-read every minute without overlapping poll requests.
An unchecked feed becomes stale after one hour. Source date and last check are
separate: a monthly ranking can be recently checked without being recently published.
Availability is not a guarantee of live match coverage. Unsupported feeds show unavailable.

## API

### Cricket coverage (14 September 2026)

Twelve connected sources replace the six cricket reference-only entries. ICC
server access was blocked, but Cricbuzz's public team-ranking pages supply men's
Test (10 teams), ODI (20) and T20I (102), and women's ODI (16) and T20I (80).
These are publisher snapshots, not permanent expected team counts. Missing
ratings remain null and published tied ranks remain tied. There is no women's
Test ICC team-ranking substitution. Public hydration JSON is decoded as data;
scripts are never executed and private APIs/embedded credentials are not used.

Official Hundred tables provide eight men's and eight women's teams. Official
ECB tables provide 18 first-class county teams in separate divisions and 18
List A One Day Cup teams in separate groups. Cricbuzz additionally supplies IPL
2026 (10), CPL 2026 (7) and Abu Dhabi T10 2025 (8) league-stage tables. These
named editions remain fixed and explicitly labelled; the 2025 T10 table is not
presented as a 2026 competition. New editions need a verified catalogue entry.
This covers every requested cricket format, not every domestic league worldwide.

Published positions, points, matches and NRR are preserved, including official
points adjustments. NRR is displayed separately from rating. A publisher's
omitted publication date remains null; retrieval time is never substituted.
The source-specific adapters validate scope, edition, groups, counts and ranks
before atomic snapshot replacement. Failed refreshes retain the last good data.

All cricket feeds join the existing 15-minute checks. A separate Celery Beat
reconciliation runs daily at 03:10 UTC / 08:40 IST, fan-outs bounded independent
source jobs, and is also available through **Reconcile all cricket now**.
POST /api/sports-rankings/cricket/reconcile requires the existing session,
rate-limits enqueue requests to once per minute and returns 202 immediately;
external source requests never run in the page API. It refreshes all sources,
including failed ones, and retains the existing per-source concurrency lock and
60-second duplicate cooldown. Queued does not mean successful; each source's
status, last check and successful retrieval are the reconciliation result.
Public-page automation works for these sources, so no manual transcription or
separate assistant reminder is needed. This does not enable trading analysis.

### Endpoints

All endpoints require the existing authenticated backend session via the BFF.

* GET /api/sports-rankings: catalogue, sources, status and publication dates.
* GET /api/sports-rankings/competitions/{id}: source rows plus unmatched imported names.
* POST /api/sports-rankings/refresh: {source_id}; returns queued, not completed.
* POST /api/sports-rankings/resolve: {code, name, competition_id?}; returns
  matched/ambiguous/unmatched candidates, source dates and rank type.
* POST /api/sports-rankings/classify: conservative full-match eligibility using
  explicit sport, participant, market-type, scope and period metadata. Exactly
  two distinct participants, not two outcome labels, are required. Partial matches,
  totals, lines, statistics and outrights are rejected. Racing/battle-royale/golf
  formats require an explicit head-to-head qualifier. Missing metadata is rejected.
  This endpoint is not wired into Bullpen trading or scan filters.

Search includes sport/category/scope and switches the selected list when the old
selection falls outside the filters. Groups, ratings, points and records are shown
separately. Duplicate references to an identical source row collapse in resolution;
different sources, rosters and ranking groups remain distinct candidates.

Name normalization is Unicode-aware, case/diacritic/punctuation insensitive. It
generates safe legal-designator, common-word and initialism variants, then applies
a conservative unique fuzzy fallback inside one competition/source. Reviewed
competition aliases remain authoritative for unrelated provider names such as
`Real Racing Club` / `Real Racing Club de Santander` to Football-Data's
`Santander`. Domestic-table fallback may reuse a reviewed alias across a cup or
continental tag, but never across rating sources. Academy, reserve, gender and
youth qualifiers must match exactly and are never removed by fuzzy resolution.
Original Polymarket names remain visible beside the provider's ranked name. Absent
or ambiguous names remain null-ranked; inferred matches are not trading authorization.
The future analysis consumer must explicitly reject ambiguous, missing, stale or
failed rankings and distinguish official rankings from derived performance order.

Schema migration: sports_rankings_001 (parent 3d4e5f6a7b8c). Existing release
migration execution creates the table before the backend and worker are promoted.

### Event comparison responsiveness

Comparison batches reuse each competition's participant rows and each team lookup
within that request. Name normalization and immutable alias keys use bounded caches;
ranking metrics are never cached between requests. CPU matching runs outside the
FastAPI event-loop thread so a large history batch cannot block health, portfolio,
or history requests. Matching thresholds, scope boundaries and ambiguity rules
are unchanged.
