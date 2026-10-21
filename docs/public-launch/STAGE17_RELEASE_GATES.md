# Stage17 — evidence and external release gates

Checked official sources on21October2026. This is an evidence checklist and implementation boundary, not legal advice, an application, agreement acceptance or approval. No live provider calls were made. Product/operator owner for unresolved decisions: Tarun Singh; legal/provider reviewers must be named by that owner before launch. All gates below are PENDING and prohibit public activation.

| Gate / accountable owner | Required evidence before release | Current status |
|---|---|---|
| Managed Kite app / product owner + Zerodha reviewer | Written approved app identity, permitted multi-user use, redirect/domain identity, consent and credential custody, data-use restrictions, withdrawal/revocation tests and exact approval reference | No approved evidence supplied; disabled |
| User-owned Kite mode / product owner | Per-owner app/account binding and authorization; confirm relevant API terms and broker requirements apply to intended use | Synthetic binding tests only; no real validation |
| Execution classification / legal counsel + broker/exchange | Written assessment of explicit-confirmation workflow against current retail-algo framework, exchange registration/hosting/static-IP and strategy obligations where applicable | No approval; never infer exemption from manual confirmation or low order rate |
| Advice/research/data use / legal counsel | Classification, authorizations/disclosures, market-data redistribution permissions and record duties | Pending; no legal approval implied |
| India-only eligibility / product/legal owner | Approved evidence types, review authority, expiry and revocation process, appeal/support path; tested trusted producer | Sealed synthetic reviewed producer tested; normal real producer unbound; email/IP/declaration do not admit |
| Privacy and retention / privacy/legal owner | Data inventory, purposes/notice, consent/withdrawal, retention matrix by category, legal holds, backup erasure handling, rights response and breach timelines with applicable commencement dates | Pending; deletion/export requests held; synthetic-only effect adapter |
| Signup abuse / security operator | Independent identity/signup rate and abuse quotas, proxy/request-body controls, CAPTCHA/step-up decision and false-positive recovery; not AI dollar budgets | Body/Origin bounds plus transactional signup quotas implemented locally; perimeter/step-up and actual deployment not verified |
| Operations / security operator | Approved queue routing/consumer limits, monitoring destination, stale/unknown/cost alerts, support-access role and audit retention, tested restore/key drill and rollback receipts | Working durable fake-worker queues, owned SQL monitoring/local alerts and consent/audited support implemented; no real operational rollout |
| Production readiness / operator + owner | Current read-only service/network/certificate/dependency inspection and vulnerability evidence, tested migration/controller inventory, independent review, current spend/deployment authorization | No host access or deployment in this task; UAT2 stopped |

Official source inventory:

- [Kite authentication](https://kite.trade/docs/connect/v3/user/) documents the request-token exchange and access-token lifecycle. A successful synthetic login is not provider approval.
- [Kite terms](https://kite.trade/terms/) must be reviewed for the specific commercial/service use. No terms were accepted by this task.
- [SEBI4February2025 retail-algo circular](https://www.sebi.gov.in/legal/circulars/feb-2025/safer-participation-of-retail-investors-in-algorithmic-trading_91614.html) and [30September2025 timeline extension](https://www.sebi.gov.in/legal/circulars/sep-2025/extension-of-timeline-for-implementation-of-sebi-circular-dated-february-04-2025-on-safer-participation-of-retail-investors-in-algorithmic-trading-_96979.html): counsel/broker must establish exact applicability and current exchange implementation evidence.
- [NSE retail-algo FAQ](https://nsearchives.nseindia.com/web/sites/default/files/inline-files/FAQ_Retail%20Algo_03112025_NSE.pdf): provider strategy hosting requirements must be reconciled with any proposed architecture; repository systemd is not proof of compliance.
- [MeitY rules/corrigendum index](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa?pageTitle=Digital-Personal-Data-Protection-Rules-2025-2) and [official PIB notification background](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190655): check operative text and commencement for each duty. Do not replace applicable rules with a generic deletion period or assume all provisions commenced together.

Source metadata and pages were inspected through web tools; no legal document was silently treated as an approval. Full applicability/commencement analysis remains pending qualified review.
