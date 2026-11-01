# A6-15 — mail-history provenance for Sell Batch

Source base: 968ac9c16ca0f88df4c68732c13792787cc66e60. The assigned worker
confirmed source coupling, but its executor failed startup twice. The sole
integrator implemented the narrow state propagation; there is no imported worker
commit for this finding.

Sell Batch derives exclusively from the displayed mail-history records. Its
metrics are unknown until a history read succeeds, verified empty results retain
zero, and retained results are explicitly cached during refresh or failure. The
empty explanation is scoped to those records. No independent batch endpoint or
authoritative current execution state is inferred.

The row derivation, financial calculations, action handlers and disabled states
are unchanged. A rendered baseline comparison verifies identical populated table
contents; a full-source AST comparison verifies all existing click/disabled JSX
attributes are unchanged. Only existing mail verification/loading/error state is
passed into the batch presentation.

Local verification: ten focused rendered/source regressions pass; TypeScript and
targeted ESLint pass. The actual full Mail page passes eight independent
preferences/GitHub/viewport combinations at 1180px and 390px, covering loading,
initial failure, verified empty/populated, cached empty/populated refresh failure,
unchanged financial values and retained keyboard focus. Zero writes, external
requests and browser errors. Synthetic narrow failure pixels were inspected.

Reproduce from frontend:

```sh
node --test tests/audit6-mail-batch-source-state.test.mjs tests/mails-stage2-alerts.test.mjs
node scripts/audit6-mail-batch-source-playwright.mjs
```

Screenshots and result JSON are local synthetic evidence under
/tmp/audit6-a6-15-browser. They do not establish live Sell Batch execution or
historical reconciliation. Report-pixel comparison and parent-owned live
acceptance remain separate; no live mail/provider operation was performed.
