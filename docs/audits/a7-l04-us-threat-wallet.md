# A7-L04: nullable US Threats wallet

Revalidated against origin/main da317a1097cef97089e3a745b9e20b4952af6a48.
The source snapshot schema allows null wallet_balance, but the Threats numeric
formatter rendered it as 0.00. This overlaps F01/F02 and the Audit5 unknown-value
contract; the defect remains at the supplied post-Audit6 baseline. This does
not establish acceptance of those broader findings.

The new prompt reads wallet_balance alone, renders absent/null as explicit
unknown, retains verified zero and positive values, and instructs the report
to retain unknown cash rather than infer a zero buffer or cash-based invested
percentage. Buying power remains a distinct concept. No wallet, buying-power,
funding, trading or allocation policy is introduced.

Tests use an unrelated synthetic snapshot identity and nullable-wallet
contract. They cover absent/null/zero/positive wallets against absent-equivalent,
zero and positive independent buying power, repeated construction, metadata
read-back and unchanged source fields. Original saved prompts and responses
are not migrated or rewritten. The existing snapshot UI already renders null
currency as a dash; no frontend code changed or browser acceptance is claimed.

Verification: US Threats 3 tests (12 wallet/buying-power subcases), Zerodha
Threats 2 tests, holding context 5 tests passed. The new US regression on the
unmodified baseline failed (9 failures, 3 absent-field errors), as expected.
An initial context-suite invocation lacked DATABASE_URL; rerunning with
synthetic local test environment values passed without database access.

Source limit: audit attachment byte transfer failed. Implementation relies on
the supplied source-contract text; no PDF checksum, pixel verification or
private saved-job inspection is claimed.

Acceptance limits: no paid provider run, production read-back, broker action,
export or deployment. Existing historical false claims remain historical.
Prompt instructions cannot by themselves guarantee provider compliance.
Integrator must publish and verify a separately authorized future run before
claiming production remediation.
