Stage 00 isolated real-engine CI candidate

Derived from private portable archive SHA256
8b8d125c0be3cc32bb9edf9162aaad808e3bdf56e6f8b2c5291e0789f6f47ec8.
Original archive and private files preserved. Fixture assembly now accepts
explicit disposable engine/client injection. Existing production code unchanged.

Only branch codex/uat-real-engines-ci push can trigger this workflow. No PR is
opened during this run: existing broad PR checks publish artifacts whose available
storage allowance has not been verified. This route uses standard Ubuntu runner
in the verified PUBLIC repository and no caches/artifact uploads/paid services.
GitHub billing documentation confirms standard public-repository runner time is
free; console logs do not consume artifact allowance.

Images and pip dependencies are fetched before tests. Runtime containers use
network none; database TCP listeners are disabled, no host ports published,
Unix socket volumes only, PostgreSQL data on bounded tmpfs, Redis persistence off.
Test container is non-root/read-only/capabilities dropped/no-new-privileges,
with explicit CPU/memory/swap/PID limits. No host Docker socket or production
configuration is mounted into tests. No repository secrets are passed. Image
digests/IDs are printed for the actual run; mutable version tags are not claimed
to provide immutable future builds. Fixture JWT keys are ephemeral synthetic
test material and never production credentials. Cleanup is limited to run-ID
named disposable containers and socket volumes; ephemeral runner owns image data.

Acceptance: six real-engine tests, zero skipped, migration up/down each fixture,
non-owner rejection before profile/session creation, owner flow/revocation,
asset barrier, disabled/conflicting owner, concurrency/capacity/TTL, real expiry,
and runtime network-interface/default-route absence. Does not validate live
Google OAuth, browser hydration, production resource pressure, host firewall,
independent watchdog, reboot recovery or external private barrier. Stage00 and
Stage01 remain blocked pending their own acceptance. No production probe rerun.
