# A10-006 / A10-007 offline replay input corrections

These changes apply only to offline evaluation. They do not select investment
policy, change historical records, fetch providers or execute trades.

## A10-006: compare UTC instants, preserve source spellings

At base `db59e08d61f27e75e9d9bc89ae668decfe51dedc`, the synthetic price sequence
100 / 101 / 103 gives a one-price-point horizon return of approximately +1.980%.
Adding a conflicting price 90 with an equivalent spelling of the 101 point's UTC
instant changes that horizon return to approximately -10.891%. This is a horizon
return, not whole-equity performance.

The helper now requires explicit timezone-aware timestamps and converts them to UTC
for duplicate checks, chronology, causal comparisons, consumed-fill lookup and
horizon indexing. Both identical and conflicting duplicate instants are rejected,
including Z, +00:00 and equivalent nonzero offsets, regardless of input order.
Missing timezone evidence is not assigned an invented timezone. Raw records,
price timestamps, source hashes, fees and supplied evidence remain unchanged;
reported fill timestamps retain their original spelling.

A10-006 tests cover equivalent duplicate instants under all point-order
permutations, unchanged valid arithmetic/fees/causality, raw-input preservation,
overlapping decisions consuming only one fill and missing timezone rejection.

## A10-007: positive integer price-point horizons only

The helper validates the supplied list/tuple before inspecting records. Each horizon
must be a positive built-in integer; booleans, strings, floating/fractional values,
zero and negatives are rejected. The CLI applies the same check before publishing
any output, including evidence-only mode when a simulation horizon is supplied.
Its existing atomic-output contract preserves source and previous report bytes on
rejection. The defaults remain 5 / 20 / 60 eligible price points. A valid positive
integer beyond available history returns null/unknown, never a fabricated result.

A10-007 tests cover helper rejection before early evidence returns, both CLI modes,
preservation of existing output, valid/default horizons and a valid long-horizon
CLI result remaining unknown. The new tests use invented isolated fixtures only.

Both IDs remain distinct from evidence completeness, profitability, calibration,
benchmark or portfolio-effectiveness claims. Shared evaluation/CLI paths must be
coordinated with the existing integration owner before publication or integration.
