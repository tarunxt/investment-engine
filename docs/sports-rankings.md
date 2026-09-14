# Sports Rankings repository

Phase 1 is an authenticated reference repository, independent of Bullpen execution.
It does not change trading decisions, filters, probabilities or existing audit snapshots.

## Coverage

The imported 14 September 2026 list contains 346 event rows, 75 URL prefixes,
95 competition/stage entries and 388 participant-name memberships. Every input
title and slug is preserved in catalogue.json. Prefixes and competition mappings
are inferred, not official IDs. A prefix may identify multiple tournaments.
Question/slug disagreements require review; the importer does not silently fix them.

Reference links are navigation only, never scraping targets. In particular,
Flashscore, ATP, WTA, ITF, GosuGamers and Liquipedia reference URLs are not ingested.
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

Football calculation: 3 points per win, 1 per draw; points descending, goal
difference descending, goals scored descending. Equal scores share a rank.
Deductions, head-to-head rules, playoffs and official tie-breaks are not modelled.
The current July-to-June season is requested; there is no silent previous-season fallback.
Only teams represented in completed matches can be included in that table.

## Refresh and reliability

Celery Beat dispatches every 15 minutes, independently of open browser tabs.
Each source runs separately on the existing ai worker queue with 70/80-second
soft/hard limits, two retries and backoff. PostgreSQL row locks prevent overlapping
writes. Successful datasets replace the complete source snapshot atomically;
failures retain the previous rows and expose the error and success timestamp.
Unchanged normalized datasets do not rewrite ranking payloads. HTTP responses
are size/time bounded; source URLs come only from a fixed provider allowlist.
All tasks log failures. No AI calls, subscriptions or API keys are required.

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
