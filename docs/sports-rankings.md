# Sports Rankings repository

Phase 1 is an authenticated reference repository, independent of Bullpen execution.
It does not change trading decisions, filters, probabilities or existing audit snapshots.

## Coverage

The imported 14 September 2026 list contains 346 event rows, 75 URL prefixes,
95 competition/stage entries and 388 participant-name memberships. Every input
title and slug is preserved in catalogue.json. Competition mappings remain inferred.
88 relevant codes were checked against Polymarket's public `/sports` registry on
14 September 2026 and are stored in polymarket_codes.json. A prefix may identify multiple tournaments.
Question/slug disagreements require review; the importer does not silently fix them.

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

Name normalization is Unicode-aware, case/diacritic/punctuation insensitive,
with explicit aliases only. It never removes academy, gender or youth qualifiers.
aliases.json contains 66 competition-scoped football name mappings reviewed against
the connected feed labels on 14 September 2026 (for example Manchester City FC to
Man City). Original imported names remain visible beside the provider's ranked name.
Aliases do not assert tournament entry or merge youth/academy/women's teams.
Absent names remain null-ranked; inferred prefix/name matches are not trading authorization.
The future analysis consumer must explicitly reject ambiguous, missing, stale or
failed rankings and distinguish official rankings from derived performance order.

Schema migration: sports_rankings_001 (parent 3d4e5f6a7b8c). Existing release
migration execution creates the table before the backend and worker are promoted.
