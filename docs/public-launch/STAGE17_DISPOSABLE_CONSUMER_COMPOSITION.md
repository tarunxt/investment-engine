# Stage 17 disposable application-to-consumer composition

Local candidate based on `f6bad85164e3bbbd5b14eaed0e25063f2b98d7e7`.
This is not a UAT2 deployment or a real-service activation record.

`DisposableConsumerFactory` pins a server-owned builder to the fingerprint of
an acknowledged disposable database. Both authenticated request sessions and
fresh worker sessions validate that fingerprint before invoking the builder.
Only existing `SyntheticWorkBindings` with separate private SQLite fake venues
and `MarketDataFake` are accepted. Analysis bindings are unavailable in this
factory. Production environment, database substitution, arbitrary network
brokers and network result backends fail closed. Effective read/write URL
overrides are checked separately; a memory base URL cannot conceal a remote
write endpoint. Custom transports, connection overrides and unrecognized
transport options are rejected before registration without constructing a
connection. The acknowledged CI Redis path accepts only a private prefix and
bounded visibility/polling options.

The exact authenticated POST
`/account/operations/disposable/operational-queue` accepts only a lane
(`execution` or `reconciliation`), resource identifier and explicit confirmation.
It derives the owner from the authenticated session, rejects extra fields and
commits durable queue admission. It does not approve orders or execute work in
HTTP. Existing exact order approval, owner, module version, connection, risk,
emergency-stop, lease and effect fences remain authoritative at consumption.
An enqueue acknowledgement is not evidence of a financial effect.

An explicit caller-owned dispatcher may publish a lane wakeup after that commit.
The application does not automatically publish, start workers, configure Beat,
register a normal-runtime factory or schedule financial execution. A failed or
missing wakeup leaves durable work pending; this candidate does not establish an
automatic delivery/recovery deadline. Repeated registration on the same Celery
app retains the same composition; other apps do not inherit its handlers.

Prepared CI coverage extends the existing actual PostgreSQL/Redis duplicate
delivery and child crash/replacement cases to begin with authenticated ASGI
admission through this factory. Additional child-worker cases cover module,
connection and approval changes after admission; foreign admission is denied
before a queue row exists. The fake venue's durable row count is asserted,
rather than trusting a process-local call counter. Existing explicit expired
Kombu reservation recovery and same-task-ID assertions remain unchanged.
These service cases require the existing acknowledged disposable CI environment;
local collection is not execution.

Unfinished work remains explicit: real consumer/scheduler composition, real
monitoring sinks and operator roster, real residency evidence acquisition and
authority bindings, signup provider/proxy bindings, complete account export,
identity/backup erasure and policy decisions for retained/shared data. None is
approved or completed by this disposable integration. UAT2 stays stopped and the
nine public/live release gates remain separate. Stage 18 has not started.
