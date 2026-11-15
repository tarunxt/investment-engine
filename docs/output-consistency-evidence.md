# Advisory output consistency evidence

`credx-output-consistency-v1` checks explicit supplied-evidence claims after the
existing deterministic Swing31/Rebalance29 contract. It never changes a financial
row, original response, prompt, score, model target, independent sample, job
status, export eligibility, retry decision or historical record. Findings never
cause another provider request. It does not evaluate strategy, market freshness,
source truth, live prices or investment advice.

## Frozen source evidence

The optional `RunCreate.output_source_jobs` field contains exact `run_id`, `job_id`
and SHA-256 of each selected raw saved response. It is separate from the model
prompt. The server verifies current-user ownership of both the Run and Job,
their exact link, Swing stage, matching target market, completed/partial status
and exact raw response version. Historical sources from older workflow sequences
are allowed. Same-content independent jobs remain separate; only identical
repeated delivery of the same job reference is collapsed. Conflicting references
fail before any new jobs are created. Failed/empty siblings remain in the original
prompt but are not submitted as checkable references. Explicit forged references
to those jobs are rejected.

Bounds are 200 references, 2,000,000 aggregate UTF-8 response bytes, 500,000 bytes
of frozen context, 20,000 indexed identities and 128 characters per identity part.
Oversized selections fail clearly rather than truncating evidence. The first SQL
query projects bounded prompt prefixes, ownership/stage/status/link metadata,
response byte lengths and each run's full member count. Only after passing the
aggregate limit does a second query fetch the selected raw responses under the
same per-job byte-length limit. Growing/changed responses require fresh selection.
It never hydrates full ORM history entities or fetches omitted source responses.

Existing `request_context_json` stores only source hashes, validated identity
indexes, parsing status/finding counts and run coverage. It does not duplicate raw
source outputs. Runtime checks use this frozen context without a database query,
market refresh or provider call. Old clients, missing contexts and malformed
contexts remain unknown; no historical backfill is performed.

## Exact supported claims

Source cells accept explicit `Swing job #123`, `Swing Trade job #123`,
`Swing Run #123`, or `Swing Trade Run #123`. Run citations can include the current
bundle's `Zerodha` or `IndMoney US` suffix. Multiple fully specified citations
separated by a semicolon, comma or `and` are checked separately. A job ID is never
treated as a run ID. Bare IDs, model-only citations, abbreviated citation lists,
negated/conditional citations and other free-form source prose are unchecked.
The current prompts prescribe the Analyst/Source column but no universal citation
syntax, so this is deliberately partial coverage.

Membership uses the exact exchange/symbol pair, with case and surrounding-space
normalization only. A positive match requires a validated source row. A job-level
absence is a mismatch only for a complete parsed job. A run-level positive checks
the union of that run's selected known source rows. A run-level absence is a
mismatch only when the server-observed total membership count equals the selected
job count, the run is completed and every member is complete/parse-complete.
Missing selections, failed/partial siblings and incomplete parsing make absence
unknown, never an invented contradiction or a claim that all sources were verified.

Price checks use whole sentences in Technical Setup and the six rationale fields.
Supported subjects are `Current price` and `Price per unit`, optionally followed
by `is`, then `below`, `above`, `less than`, `greater than`, `at most`, `at least`,
`equal to`, `<`, `>`, `<=`, `>=` or `=` and one decimal amount. A supported sentence
can appear between other narrative sentences. Unsupported sentences are unchecked.
For example, `Weak volume persists. Current price is below 120. Buy only if momentum
improves.` checks only the middle sentence against the same row's supplied
`price_per_unit`. It does not retrieve, substitute or infer a current market price.

Negation, past/future/modal/conditional qualifications, embedded quotations,
questions, ranges, percentages, basis points, ambiguous currency symbols and other
prose stay unchecked. Optional explicit currency codes (USD, INR, EUR, GBP, JPY,
CAD, AUD, CHF, CNY, HKD, SGD) must match an explicitly supplied row currency;
otherwise the comparison is unknown. A bare threshold is compared numerically
within the supplied price field's units. There is no currency conversion.

## Reporting and display

The additive `runtime_metadata_json.deterministic_output.consistency` report has
per-field provenance and statuses `consistent`, `inconsistent`, `unknown` and
`unchecked`. Supported checks retain quoted evidence; unsupported text remains in
the original output and is linked by field/sentence hash rather than duplicated.
All rows and observed check counts are retained. Detail is bounded to 400 checks
and less than 100,000 UTF-8 bytes; conflicts get priority, retained checks stay in
original order, and `detail_limit_reached` plus `omitted_check_counts` explicitly
report omitted details. No omitted checks are implied to have passed.

Job detail and the shared run detail render one read-only advisory notice with
conflict counts, quoted evidence and unknown/unchecked limitations. Legacy outputs
without a report gain no validation claim. Existing response tables and buttons
remain unchanged. The existing deterministic contract version/status remains
separate from this advisory report.
