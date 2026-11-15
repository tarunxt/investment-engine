# Dormant Alpaca IEX display adapter

`GET /indmoney-us/prices/display?instruments=NASDAQ:ABC` is authenticated and
owner scoped. It never calls account, assets, orders, paper or live trading APIs.
It uses only `GET https://data.alpaca.markets/v2/stocks/trades/latest` with explicit
`feed=iex` and `currency=USD`; it never falls back to paid SIP or another vendor.
IEX is one exchange, not consolidated US-market LTP. Paper keys are not inherently
read-only: this adapter's fixed endpoint restriction is an application restraint,
not a claim about the key's account permissions.

The documented latest-trades endpoint excludes trade conditions that do not update
bar prices. Returned source trade time, server receipt time, listing MIC, execution
venue, vendor symbol, security identity, share class, currency, coverage, session
window, staleness and missing/error reason remain distinct. A source price older
than 120 seconds is marked stale, never freshened by a cache read. Regular-hours
classification only checks local time and weekday; it is explicitly not a verified
holiday calendar. `eligible_for_readiness` remains false until a proper calendar
and readiness policy are implemented. All displayed prices are estimates.

Sources checked 2026-11-02:
- https://docs.alpaca.markets/us/reference/stocklatesttrades-1
- https://docs.alpaca.markets/us/docs/market-data-faq

## Secure setup status

No verified authenticated Alpaca credential-entry/storage mechanism was found in
the repository. No key was generated, read, copied, stored, rotated or configured.
The existing Upstox documentation describes an operator Secrets Manager dynamic
reference and `asm-exec` flow, but explicitly leaves production launcher, secret
identity, resolution backend and ingestion unverified. That is not evidence of a
working Alpaca secret-entry path. Do not put credentials into chat, source control,
PRs, task text, command arguments or frontend configuration.

Actual setup requires separate approval and the repository-required
`aws-secrets-manager` skill before any credential handling. Verify production's
secret launcher and identity permissions, perform approved secure ingestion,
resolve credentials at runtime, bind the verified owner, and test a small
read-only data request. Do not accept terms, subscribe, fund, trade or register
OAuth infrastructure as part of this code change.

The dormant adapter expects runtime names `ALPACA_DATA_KEY_ID`,
`ALPACA_DATA_SECRET_KEY`, `ALPACA_LTP_OWNER_USER_ID` and an explicit
`ALPACA_LTP_ENABLED=true`. It also needs a separately verified, nonsecret security
master in `ALPACA_LTP_LISTINGS_JSON`. Nothing in this task sets these names.
Missing configuration or a different authenticated owner returns Unavailable
without a provider request.

Each verified mapping record requires `instrument`, `symbol`, `listing_mic`,
`share_class`, `security_id`, `vendor_symbol`, `currency=USD` and `verified=true`.
No records are shipped or inferred from model output. Duplicate/ambiguous mappings
and generic US listings fail closed. Mapping lookup must not add a second holding
for a generic US alias. Existing ambiguous rows are visible but excluded from
allocation pending verified resolution.

Shared Redis guard code is reused without changing Zerodha. Alpaca has an isolated
namespace and owner budget. It inherits the conservative sliding request limits,
five-second cache, cross-worker coalescing, shared Retry-After cooldown and
fail-closed coordination. Cold or lost quota history inherits the existing
30-minute safety warmup; this must be understood before enabling a production
read. Credential and mapping generations isolate cached results; rotating a key
does not reset the owner's quota budget. No automatic retries or feed switching.

## Verification

The adapter tests use dummy credentials, a fake Redis guard and httpx MockTransport;
no real Alpaca request occurs. Run the module tests with the repository backend
test environment. In a minimal checkout, copy this pure-module test to a temporary
directory to avoid the repository-wide telemetry fixture's unrelated DB imports,
then set PYTHONPATH to backend and the isolated pytest/httpx/redis installation.
The frontend `test:indmoney-basket-offline` fixture verifies real shared calculation
components and popup stacking in light/dark themes with all external URLs blocked.

## Proposed secure configuration path (not implemented or approved)

The proposed credential destination is an owner-specific AWS Secrets Manager
record, for example `/investor/production/alpaca/iex/<verified-owner-id>`, holding
separate key-ID and secret-key fields. This is only a proposed name, not an
existing secret identity or ARN. Confirm account, region, actual owner, encryption
key and approved ingestion mechanism before any write. Enter existing credentials
through that approved operator channel; no chat, issue, repository or key creation
is required by this proposal.

The production integration target would be the verified systemd backend launcher
and `/etc/investor/backend.env` using dynamic references resolved by approved
`asm-exec`. The file would contain references, not raw credentials, with root
ownership and restrictive permissions (proposed 0600). Confirm that the actual
service user/launcher can read those references before changing permissions.
The runtime IAM identity would receive only `secretsmanager:GetSecretValue` on
the exact approved secret ARN, plus narrowly scoped KMS decrypt only if required
by its encryption key. The runtime identity would not gain create/update/rotate
or wildcard secret permissions. Operator ingestion permissions would be separate
and individually approved. No IAM, file-permission or service changes are made
by this task.

A future authenticated `GET /indmoney-us/prices/provider-status` could return
only masked readiness flags: owner configuration available, fixed provider/feed,
verified mapping availability, and safe reason codes. Other users would receive
only unavailable. It must never return key prefixes/suffixes, key hashes, raw env
values, secret identifiers, credentials or provider error bodies. `/console/apis`
is usage reporting, not a credential-entry form. An optional owner UI would show
status only, not invent a browser key field before secure ingestion is approved.
This endpoint/UI proposal is deliberately not implemented in this change.

Approval sequence: review the destination/permissions above; verify the skill and
launcher; approve secure ingestion of already-existing paper credentials; approve
owner/mapping configuration; then separately approve activation and a small fixed
read-only data test. Paper Trading confirmation alone does not authorize those
actions. No regeneration, key replacement, term acceptance, subscription or
paper/live trading is part of any step.

## Local canonical identity path

The shared stock-flow source reads only the existing nonsecret owner-bound mapping
via authenticated `/indmoney-us/prices/listings`. It never sends holdings to a
vendor, reads credentials or creates mappings. Both the widget and basket pass
that same metadata into consensus construction **before** votes or holdings are
attached. India keeps its existing path.

A generic US alias resolves only when exactly one verified symbol/share-class/
listing record matches. Canonical keys include security ID, listing MIC and share
class. Independent real listings stay separate. Generic holdings attach only when
the full verified symbol mapping is unambiguous and the snapshot is complete;
otherwise holdings remain unavailable, not zero. Missing mapping does not become
a guessed NASDAQ default. The previous default has been removed.

Every original parsed row remains in `stock.rows`, unchanged, with run/job/parsed
source-row index and original symbol/venue in `sourceRowLinks`. A separate
`consensusRows` list gives each job at most one vote per verified security. A
same-job contradictory action or differing alias observation blocks the decision;
all original rows remain reviewable. Conflicting actions from independent jobs
remain legitimate separate votes. Raw-row UI keys include source-row indices for
canonicalized US stocks so aliases cannot overwrite each other's rendered rows.

Historical score matching may accept a generic US alias only for an unambiguous
verified security. Original observation objects, identities, IDs, timestamps and
scores are retained; no saved history is rewritten. Equal same-run alias entries
count once. Contradictory same-run alias scores/actions are excluded with their
original observations and an explanation, rather than selecting the first one.

A synthetic fixture models 20 economic securities represented by 33 raw rows. With
verified synthetic mappings it produces 20 consensus stocks, 20 holdings and 33
original linked rows. It also covers same-job contradictions, independent-job
votes, missing mappings and genuine dual listings. No real portfolio data is
included in fixtures.

No actual US security master was verified or configured in this task. Existing
Indian Upstox instrument metadata does not identify US listings. Model exchange
labels and INDmoney's symbol-only holdings are insufficient proof. Actual Run123
resolution therefore still needs authoritative records for its symbols, share
classes and listing MICs, supplied through the separately approved nonsecret
mapping setup. Code can resolve those records when available; it does not fabricate
them or claim that the live 33 rows have already been resolved.
