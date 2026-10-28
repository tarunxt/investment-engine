# Conditional privacy targets and disposable suppression

Local successor work began 2026-10-24 05:39:40 UTC from the preserved, published
267b4760df4773e9ded1f2ac030c106f872627fc. This successor is not published or deployed.

## Owner-selected design, not statutory periods

Eligible live profile, supported upload and analysis categories have a proposed
30-day target measured from a reviewed eligibility/purpose-end trigger. This is
not a mandatory retention minimum, a legal deadline or permission to delay an
applicable earlier deadline. A reviewed earlier erase-by date takes precedence;
legal holds, conflicting duties, missing ownership/legal mapping, expiry and
unmapped stores hold the proposal. Every actual inventory store must be covered
by the typed review, matching inventory and source-category hashes. Identity,
audit, credentials and unknown financial/operator stores receive no blanket
30-day deletion rule. The SQL bridge rebuilds the complete typed review and retains source-review expiry and existing
FK hold propagation; real deletion is always disabled.

Saved Stage17 section38 controls owner-fenced workflows, synthetic sinks and
retention gates. The official [DPDP Act text, section8(7)](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf)
was checked: retention necessary under applicable law can override erasure.
That source does not establish which duties, commencement provisions, entity
classification, jurisdictions or financial obligations apply to this service.
No statutory period, blanket banking rule or legal approval is inferred. Those
mappings remain explicit review requirements. The owner's design selection
resolves the proposed approach; it does not supply missing legal facts.

## Minimal restricted audit and selective unlinking

Only an exactly scoped disposable fixture may null three actual nullable profile
fields: avatar_url, bio and google_sheets_master_url. The full typed review is
revalidated against the proposal, owner, request and exact inventory. No identity,
credential, permissions, notifications, scheduling or other security settings
are changed. This remains partial unlinking, not identity anonymization.

The retained owner-indexed encrypted audit/suppression record contains request,
policy and scope bindings, fixed event/field names, category counts and time.
It retains no old profile text, URL, name, email, upload or order payload. Existing
owner fences and caller-provided keyring protect it; no key is acquired and no
new permission scheme is installed. The owner/request anchor remains personal
linkage and is not described as anonymous. No audit retention period is invented.
This new encrypted topic is not silently counted as a complete account-export
adapter; broader coverage remains held.

## Proposed backup expiry and actual fixture restore consumer

The backup planner proposes a rolling 30-day target from copy creation. It needs
complete copy inventory and an applicable-duty review; legal holds override it.
It cannot purge, change schedules or keys, prove all replicas expired, or claim
complete erasure. Actual live copy inventories and retention controls remain
unverified and unchanged.

The selected-profile fixture consumer calls the independent retained suppression
ledger inside the existing recovery savepoint before restoration commits. Old
profile values stay null after service recreation. Foreign/missing/corrupt ledger
linkage, unsupported fields and non-profile backup categories fail closed; final
audit failure rolls back the transaction. Do not use the generic historical
recovery adapter as a suppression-aware consumer. Uploads, analysis blobs, other
backup stores and deployed restore orchestration still need their reviewed
ownership/projection adapters and independent ledger inventory. No real restore
or deletion adapter is activated.

## Review and verification

Independent review identified and reproduced a schedule expiry extension; the
bridge now caps expiry at the original review expiry, with a focused regression.
The review also identified the helper-only suppression gap; a concrete consumer
now applies suppression inside the inherited restore transaction. Typed-review
revalidation prevents edited dispositions from stripping a retained hold. A
second review finding is fixed by binding eligibility time, its evidence hash,
owner and request into the typed review, so a proposal cannot rebase its clock.

39 new policy tests and 33 affected SQL-planning/recovery tests pass, zero skips
(72 total; not additive to earlier results). These use SQLite synthetic fixtures.
The policy tests are prepared as a separate exact-count Stage17 CI step; they
have not run remotely. Real PostgreSQL policy qualification remains pending.

Actual applicable-duty/hold mapping, deployed copy inventory and full-store
restore suppression remain blocked. Real erasure, live backup schedules,
credentials, encryption keys, security settings, production and UAT2 are unchanged.
