# Local-only proposal: stable verification of one PostgreSQL16 check

Publication gate: this runtime correction is NOT pushed. Draft PR1252 remains at test-only diagnostic head3dfa94826684176e679f37577de0d67918184860. Parent must resolve the precise new runtime-publication approval before any push/rerun. No deployment or live database action is authorized.

## Verified failure and preserved evidence

Original4668e2a9 run39460845285 and diagnostic3dfa9482 run39462281660 both terminated with23/26 jobs passing and three Stage10 Linux groups failing. All20 current controller cases executed with zero skips;13 passed and7 failed. The29 PostgreSQL cases and historical19 Stage09 controller cases passed. Original native artifact/source/offline audit passed:127 payloads,125 wheels,690 exact application source files, manifest281abd9e17cf935b3bffe13c7a9684d40a41ddfd870958b4b576a38ef3debb3b. It is not relabeled for another head.

The test-only diagnostic commit changed no runtime source or expected result. Its retained exact fingerprint inputs show only `integration_connections.checks.ck_connection_mode.sqltext` differs after real pg_restore. Rows, sequences, indexes, other constraints, owners/grants and other catalog objects match. Controller correctly leaves apps stopped and durable recovery marker retained when verification fails.

Before restore PostgreSQL16 decompiles the membership check with an outer varchar-array→text-array cast. After restore it decompiles the same literals with individual varchar→text casts. The official catalog API documents that [pg_get_constraintdef reconstructs the definition rather than returning the original SQL](https://www.postgresql.org/docs/16/functions-info.html#FUNCTIONS-INFO-CATALOG-TABLE).

## Narrow proposed correction

`canonical_checks` maps only the two exact observed strings, only for table `integration_connections` and constraint `ck_connection_mode`, to the original pre-restore representation. It does not remove casts generally, omit constraints, ignore unknown expressions or change database definitions. All check names/comments, columns/types/nullability, rows, sequences, other constraints and catalog/ACL data stay fingerprinted. An added allowed value, appended OR true, another table/name or unknown SQL remains different and fails verification.

The original representation is retained as canonical, so a fresh pre-restore backup fingerprint does not change. Local replay of both exact retained positive/same-revision snapshots reproduces their original backup fingerprints; altering a row, constraint or grant still mismatches. Raw evidence remains unchanged at task-3/stage10-ci/{4668e2a9,3dfa9482}; replay proof is3dfa9482/constraint-local-replay.json.

## Validation and remaining gate

58 native controller/helper unit tests pass, including both exact forms, unknown/tampered SQL, scope and comment preservation. A new Docker-only PostgreSQL contract prepares real creation/acceptance/rejection checks for both forms, including NULL, unknown values, case changes and varchar length. This new check has NOT executed; the proposed exact-head Docker minimum is strengthened from29 to30, with zero skips still required. All20 Linux cases must pass on a newly approved exact head; replay alone is not live/CI recovery acceptance.

Smallest next gate: independently review and explicitly authorize publishing this exact local correction plus the new PostgreSQL contract and rerunning required CI/artifact verification. No merge/deployment, credentials, provider activation, AWS, UAT2/production or Stage11 changes are included.
