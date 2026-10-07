import asyncio
from types import SimpleNamespace

import pytest
from celery import Celery, Task
from kombu.transport.redis import PrefixedStrictRedis

from app.core.recovery import (
    ANALYSIS_QUEUE, ANALYSIS_TASK, ZERODHA_SYNC_TASK, TRANSPORT_PREFIX, RecoveryBlocked,
    RecoveryMiddleware, recovery_mode, require_bullpen_command_allowed,
    require_indmoney_analysis,
)
from app.infrastructure.messaging.recovery_celery import (
    RecoveryCelery, RecoveryTask, configure_recovery_queue,
)


@pytest.fixture
def recovery(monkeypatch):
    monkeypatch.setenv("CREDX_RECOVERY_MODE", "1")


def test_default_preserves_normal_policy(monkeypatch):
    monkeypatch.delenv("CREDX_RECOVERY_MODE", raising=False)
    assert not recovery_mode()
    require_bullpen_command_allowed(["polymarket", "buy"])
    require_indmoney_analysis(None, {"kind": "polymarket_bullpen_event"}, auto_export=True)


@pytest.mark.parametrize("value", ["", "true", "yes", "2", " 1", "invalid"])
def test_malformed_mode_refuses_execution(monkeypatch, value):
    monkeypatch.setenv("CREDX_RECOVERY_MODE", value)
    with pytest.raises(RecoveryBlocked):
        recovery_mode()


@pytest.mark.parametrize("args", [
    ["polymarket", "buy"], ["polymarket", "sell"], ["polymarket", "redeem"],
    ["polymarket", "claim"], ["polymarket", "orders", "--cancel-all"],
    ["wallet", "send"], ["unknown", "new-write"], ["doctor", "auth", "--refresh"],
    ["polymarket", "positions"],
])
def test_cli_denied_before_any_classification_or_execution(recovery, args):
    from app.domains.polymarket.runtime_broker import BullpenRuntimeBroker
    broker = object.__new__(BullpenRuntimeBroker)
    with pytest.raises(RecoveryBlocked):
        asyncio.run(broker.execute_raw(args))
    with pytest.raises(RecoveryBlocked):
        asyncio.run(broker._execute_process(
            args, timeout_seconds=1, command_category="untrusted", is_write=False,
            requires_auth=False,
        ))


def test_bot_state_cannot_initialize_background_tasks(recovery, monkeypatch):
    from app.domains.polymarket.service import PolymarketBotManager
    from app.domains.polymarket_direct.service import PolymarketDirectBotManager
    from app.domains.polymarket.bot import PolymarketPaperCopyBot
    def forbidden(*a, **k):
        pytest.fail("Background work was scheduled")
    monkeypatch.setattr(asyncio, "create_task", forbidden)
    for manager in (PolymarketBotManager(), PolymarketDirectBotManager()):
        with pytest.raises(RecoveryBlocked):
            asyncio.run(manager.get_bot(2))
    bot = object.__new__(PolymarketPaperCopyBot)
    with pytest.raises(RecoveryBlocked):
        asyncio.run(bot.init())
    with pytest.raises(RecoveryBlocked):
        asyncio.run(bot.start())
    asyncio.run(bot._force_redeem_claim_background())  # exits before even a lock
    with pytest.raises(RecoveryBlocked):
        asyncio.run(bot._run_redeem_claim_background(success_message="test"))


def test_direct_order_and_rpc_submit_denied_before_client_or_network(recovery, monkeypatch):
    from app.domains.polymarket_direct import direct_polymarket as direct
    def forbidden(*a, **k):
        pytest.fail("Client/network touched")
    monkeypatch.setattr(direct, "_build_clob_client", forbidden)
    monkeypatch.setattr(direct.requests, "post", forbidden)
    with pytest.raises(RecoveryBlocked):
        direct._place_order(None, None)
    with pytest.raises(RecoveryBlocked):
        asyncio.run(direct.DirectPolymarketLiveExecutor().execute(None))
    for method in ("eth_sendRawTransaction", "eth_sendTransaction", "unknown"):
        with pytest.raises(RecoveryBlocked):
            direct._rpc_call(None, method, [])


def test_zerodha_mutation_denied_before_http(recovery):
    from app.domains.zerodha.service import ZerodhaService
    service = object.__new__(ZerodhaService)
    with pytest.raises(RecoveryBlocked):
        asyncio.run(service.place_order("fixture-token", {}))
    with pytest.raises(RecoveryBlocked):
        service._request_sync("DELETE", "/orders/regular/123", access_token="fixture-token")


@pytest.mark.parametrize("portfolio,context,export", [
    (None, None, False), ("zerodha", None, False),
    ("india", {"kind": "equity_output_sources_v1", "market": "us"}, False),
    ("indmoney_us", {"kind": "polymarket_bullpen_event"}, False),
    ("indmoney_us", {"kind": "equity_output_sources_v1", "market": "india"}, False),
    ("indmoney_us", {}, False), ("indmoney_us", None, True),
])
def test_job_context_narrow_allowlist(recovery, portfolio, context, export):
    with pytest.raises(RecoveryBlocked):
        require_indmoney_analysis(portfolio, context, auto_export=export)


def test_indmoney_equity_context_allowed(recovery):
    require_indmoney_analysis("indmoney_us")
    require_indmoney_analysis("indmoney_us", {"kind": "equity_output_sources_v1", "market": "us"})


def test_ineligible_worker_job_never_registers_updates_or_calls_provider(recovery, monkeypatch):
    from app.domains.jobs import tasks
    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): pass
    monkeypatch.setattr(tasks, "SyncSessionLocal", Session)
    monkeypatch.setattr(tasks, "SyncJobRepository", lambda db: SimpleNamespace(
        get=lambda job_id: SimpleNamespace(auto_rebalance_portfolio="indmoney_us",
                                          request_context_json={"kind": "polymarket_bullpen_event"}),
    ))
    monkeypatch.setattr(tasks, "register_job_task_sync", lambda *a: pytest.fail("registered rejected job"))
    with pytest.raises(RecoveryBlocked):
        tasks.execute_ai_job.run(123)


def test_producers_reject_before_session_or_locks(recovery):
    from app.domains.jobs.use_cases.create_job import CreateJobUseCase, CreateJobCommand
    from app.domains.runs.use_cases.create_run import CreateRunUseCase, CreateRunCommand
    with pytest.raises(RecoveryBlocked):
        asyncio.run(object.__new__(CreateJobUseCase).execute(CreateJobCommand(
            prompt="test", provider="test", model="test", user_id=1,
        )))

    with pytest.raises(RecoveryBlocked):
        asyncio.run(object.__new__(CreateRunUseCase).execute(CreateRunCommand(
            prompt="test", targets=[], user_id=1, auto_rebalance_portfolio="indmoney_us",
            polymarket_event_context={"kind": "polymarket_bullpen_event"},
        )))


@pytest.mark.parametrize("stage", ["holdings", "events", "threats", "swing", "rebalance", "technical"])
@pytest.mark.parametrize("portfolio,market", [("indmoney_us", "us"), ("india", "india")])
def test_equity_fanout_preserves_identity_and_uses_only_recovery_queue(recovery, monkeypatch, stage, portfolio, market):
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock
    from app.domains.runs.use_cases import create_run as producer
    from app.domains.jobs.models import Job
    from app.domains.jobs.tasks import execute_ai_job
    # Exercise the real task against recovery configuration, then restore the
    # shared application config so normal-mode tests remain independent.
    app = execute_ai_job.app
    for key in ("task_queues", "task_default_queue", "task_default_exchange",
                "task_default_routing_key", "task_routes", "task_create_missing_queues",
                "broker_transport_options", "result_backend_transport_options",
                "beat_schedule", "task_always_eager", "worker_enable_remote_control", "imports"):
        monkeypatch.setitem(app.conf, key, app.conf.get(key))
    configure_recovery_queue(app)
    jobs, publications = [], []
    class Session:
        flush = AsyncMock()
        commit = AsyncMock()
        def add(self, obj):
            if isinstance(obj, Job):
                obj.id = len(jobs) + 1
                jobs.append(obj)
    class Repo:
        async def create(self, run):
            self.run = run
            run.id = 123
        async def get(self, run_id): return self.run
    class Lock:
        @asynccontextmanager
        async def acquire(self, *args, **kwargs): yield None
    targets = [producer.RunModelTarget("fixture-a", "model-a"),
               producer.RunModelTarget("fixture-b", "model-b")]
    monkeypatch.setattr(producer, "freeze_output_source_context", AsyncMock(return_value=None))
    monkeypatch.setattr(producer, "filter_recently_available_targets", AsyncMock(return_value=(targets, [])))
    monkeypatch.setattr(producer, "register_job_task", AsyncMock())
    def publish(self, name, **options):
        publications.append((name, options))
        return SimpleNamespace(id="fixture-task-" + str(len(publications)))
    monkeypatch.setattr(Celery, "send_task", publish)
    uc = object.__new__(producer.CreateRunUseCase)
    uc._session, uc._run_repo, uc._lock = Session(), Repo(), Lock()
    run = asyncio.run(uc.execute(producer.CreateRunCommand(
        prompt=f"Fixture {portfolio} {stage}", targets=targets, user_id=2,
        auto_rebalance_portfolio=portfolio, auto_rebalance_sequence=7,
        auto_rebalance_label=f"INDmoney Run 7 ({stage})", allow_parallel=True,
        auto_export_enabled=True, export_sheet_name="requested-by-existing-ui",
    )))
    assert len(jobs) == len(publications) == 2
    assert run.auto_export_enabled is False
    assert run.export_status == "disabled"
    assert all(j.auto_rebalance_portfolio == portfolio and
               j.auto_rebalance_sequence == 7 and stage in j.auto_rebalance_label for j in jobs)
    assert all(name == ANALYSIS_TASK and options["queue"] == ANALYSIS_QUEUE and
               options["exchange"] == ANALYSIS_QUEUE and
               options["routing_key"] == ANALYSIS_QUEUE for name, options in publications)


def test_task_publication_allowlist_and_explicit_queue_rewrite(recovery, monkeypatch):
    calls = []
    monkeypatch.setattr(Celery, "send_task", lambda self, name, **kw: calls.append((name, kw)))
    app = RecoveryCelery("test", broker="redis://localhost:6379/0",
                         backend="redis://localhost:6379/0", task_cls=RecoveryTask)
    configure_recovery_queue(app)
    with pytest.raises(RecoveryBlocked):
        app.send_task("app.domains.polymarket_auto_live.tasks.execute_auto_live_order_intent")
    assert not calls
    app.send_task(ANALYSIS_TASK, args=[1], queue="ai", routing_key="auto_live", exchange="beat")
    assert calls[0][1]["queue"] == ANALYSIS_QUEUE
    assert calls[0][1]["routing_key"] == ANALYSIS_QUEUE
    assert calls[0][1]["exchange"] == ANALYSIS_QUEUE
    with pytest.raises(RecoveryBlocked):
        app.send_task(ANALYSIS_TASK, producer=object())
    bad = type("FinancialTask", (RecoveryTask,), {"name": "financial"})()
    with pytest.raises(RecoveryBlocked): bad.before_start("id", [], {})
    with pytest.raises(RecoveryBlocked): bad()
    with pytest.raises(RecoveryBlocked): bad.apply_async(queue="ai")


def test_transport_prefix_keeps_legacy_reservations_outside_recovery(recovery):
    app = RecoveryCelery("test", broker="redis://localhost:6379/0", backend="redis://localhost:6379/0")
    configure_recovery_queue(app)
    client = PrefixedStrictRedis(global_keyprefix=app.conf.broker_transport_options["global_keyprefix"])
    legacy = {"unacked": {"reserved": "financial"}, "unacked_index": ["reserved"], "beat": ["financial"]}
    for command, key in (("HGET", "unacked"), ("HDEL", "unacked"),
                         ("ZREVRANGEBYSCORE", "unacked_index"), ("ZREM", "unacked_index"),
                         ("SET", "unacked_mutex"), ("LPUSH", ANALYSIS_QUEUE)):
        prefixed = client._prefix_args([command, key, "fixture"])
        assert prefixed[1] == TRANSPORT_PREFIX + key
        assert prefixed[1] not in legacy
    assert app.backend.get_key_for_task("fixture").startswith(TRANSPORT_PREFIX.encode())
    assert app.conf.task_create_missing_queues is False
    assert set(app.conf.task_routes) == {ANALYSIS_TASK, ZERODHA_SYNC_TASK}
    assert app.conf.beat_schedule == {}
    assert app.conf.worker_enable_remote_control is False


def test_recovery_rejects_brokers_without_key_isolation(recovery):
    app = RecoveryCelery("test", broker="memory://", backend="cache+memory://")
    with pytest.raises(RecoveryBlocked): configure_recovery_queue(app)


def test_analysis_publication_refuses_unisolated_app(recovery, monkeypatch):
    calls = []
    monkeypatch.setattr(Celery, "send_task", lambda *a, **kw: calls.append(kw))
    app = RecoveryCelery("unconfigured", broker="redis://localhost:6379/0",
                         backend="redis://localhost:6379/0")
    with pytest.raises(RecoveryBlocked): app.send_task(ANALYSIS_TASK, args=[1])
    assert not calls


def test_normal_celery_routes_and_submission_are_preserved(monkeypatch):
    monkeypatch.setenv("CREDX_RECOVERY_MODE", "0")
    app = RecoveryCelery("normal", broker="redis://localhost:6379/0",
                         backend="redis://localhost:6379/0", task_cls=RecoveryTask)
    app.conf.task_routes = {"financial": {"queue": "ai"}}
    app.conf.beat_schedule = {"existing": {"task": "financial", "schedule": 60}}
    configure_recovery_queue(app)
    assert app.conf.task_routes == {"financial": {"queue": "ai"}}
    assert "existing" in app.conf.beat_schedule
    assert not app.conf.broker_transport_options.get("global_keyprefix")
    calls = []
    monkeypatch.setattr(Celery, "send_task", lambda self, name, **kw: calls.append((name, kw)))
    app.send_task("financial", args=[1], queue="ai")
    assert calls[0][1]["queue"] == "ai"


def test_actual_qos_visibility_restore_never_reads_legacy_15_messages(recovery, monkeypatch):
    """Run Kombu's real restore/Redis lock path, replacing only socket I/O."""
    from contextlib import contextmanager
    from copy import deepcopy
    from redis import Redis
    from kombu.transport.redis import QoS
    legacy = {"unacked": {str(i): "financial" for i in range(15)},
              "unacked_index": list(range(15)), "beat": ["financial"]}
    original = deepcopy(legacy)
    commands = []
    def socketless_execute(self, *args, **kwargs):
        commands.append(args)
        if args[0] == "SET":
            assert args[1].startswith(TRANSPORT_PREFIX)
            return True
        if args[0] == "ZREVRANGEBYSCORE":
            return legacy.get(args[1], [])
        if args[0] == "EVALSHA":
            # Real redis-py lock release; actual key argument is prefixed.
            assert args[3].startswith(TRANSPORT_PREFIX)
            return 1
        pytest.fail(f"Unexpected Redis command {args[0]}")
    monkeypatch.setattr(Redis, "execute_command", socketless_execute)
    client = PrefixedStrictRedis(global_keyprefix=TRANSPORT_PREFIX)
    @contextmanager
    def acquire(*args): yield client
    channel = SimpleNamespace(conn_or_acquire=acquire, unacked_key="unacked",
                              unacked_index_key="unacked_index",
                              unacked_mutex_key="unacked_mutex",
                              unacked_mutex_expire=10, visibility_timeout=0, do_restore=False)
    qos = QoS(channel)
    qos.restore_visible(interval=1)
    assert legacy == original
    assert any(c[0] == "ZREVRANGEBYSCORE" and
               c[1] == TRANSPORT_PREFIX + "unacked_index" for c in commands)
    assert not any("unacked_index" in c or "unacked" in c or "beat" in c for c in commands)


def test_full_api_lifespan_and_route_guard_with_isolated_dependencies(recovery, monkeypatch):
    from unittest.mock import AsyncMock
    from fastapi.testclient import TestClient
    import app.main as main
    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
    monkeypatch.setattr(main, "AsyncSessionLocal", Session)
    monkeypatch.setattr(main, "seed_system_prompts", AsyncMock())
    monkeypatch.setattr(main, "get_bullpen_runtime_broker", lambda: SimpleNamespace(validate_startup=lambda: None))
    monkeypatch.setattr(main, "close_bullpen_runtime_broker", AsyncMock())
    for manager in (main.polymarket_bot_manager, main.polymarket_direct_bot_manager,
                    main.polymarket_auto_live_bot_manager):
        monkeypatch.setattr(manager, "get_bot", AsyncMock(side_effect=AssertionError("bot invoked")))
    with TestClient(main.app) as client:
        assert client.get("/health/live").json() == {"status": "ok"}
        for route in ("/polymarket/state", "/polymarket-direct/state", "/polymarket-auto-live/state"):
            assert client.get(route).status_code == 503
        assert client.post("/zerodha/orders", json={}).status_code == 503
        assert client.post("/runs/123/cancel").status_code == 503
    for manager in (main.polymarket_bot_manager, main.polymarket_direct_bot_manager,
                    main.polymarket_auto_live_bot_manager):
        manager.get_bot.assert_not_called()


def test_worker_ready_hooks_do_not_dispatch_or_touch_legacy_state(recovery):
    from app.domains.sports_rankings.tasks import prime_rankings_on_start
    from app.infrastructure.messaging.celery_app import (
        mark_received_auto_live_planning_task,
        reconcile_interrupted_auto_live_runs_after_worker_restart,
    )
    # Missing sender/request objects are intentional: returns precede any use.
    prime_rankings_on_start()
    mark_received_auto_live_planning_task()
    reconcile_interrupted_auto_live_runs_after_worker_restart()


@pytest.mark.parametrize("method,path,allowed", [
    ("GET", "/indmoney-us/portfolio", True), ("GET", "/providers", True), ("POST", "/runs", True),
    ("POST", "/auth/login", True), ("GET", "/runs/123", True),
    ("POST", "/indmoney-us/events/run", True), ("POST", "/indmoney-us/threats/run", True),
    ("GET", "/polymarket/state", False), ("GET", "/polymarket-direct/state", False),
    ("GET", "/zerodha/status", True), ("GET", "/zerodha/login-url", True),
    ("GET", "/zerodha/portfolio", True), ("GET", "/zerodha/portfolio/2026-10-07", True),
    ("POST", "/zerodha/callback", True), ("POST", "/zerodha/portfolio/sync", True),
    ("POST", "/zerodha/threats/run", True), ("POST", "/zerodha/events/run", True),
    ("GET", "/zerodha/threats/latest", True), ("GET", "/zerodha/events/history", True),
    ("POST", "/zerodha/threats/unknown-write", False),
    ("POST", "/zerodha/orders", False), ("GET", "/zerodha/orders", False),
    ("POST", "/zerodha/portfolio/unknown-write", False),
    ("DELETE", "/zerodha/portfolio/2026-10-07", False), ("POST", "/runs/123/cancel", False),
    ("POST", "/runs/final-actionables/history/backfill", False),
    ("POST", "/unrecognized/new-financial-route", False),
])
def test_http_boundary_prevents_handler_execution(recovery, method, path, allowed):
    reached, messages = [], []
    async def endpoint(scope, receive, send): reached.append(scope)
    async def send(message): messages.append(message)
    asyncio.run(RecoveryMiddleware(endpoint)(
        {"type": "http", "method": method, "path": path}, None, send,
    ))
    assert bool(reached) is allowed
    if not allowed: assert messages[0]["status"] == 503


def test_zerodha_login_token_exchange_allowed_but_orders_stay_blocked(recovery, monkeypatch):
    import httpx
    from app.domains.zerodha.service import ZerodhaService
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"status": "success", "data": {"access_token": "fixture"}})
    client_class = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client_class(
        **kwargs, transport=httpx.MockTransport(respond)))
    service = ZerodhaService()
    monkeypatch.setattr(service, "_checksum", lambda _: "fixture-checksum")
    result = asyncio.run(service.exchange_token("fixture-request-token"))
    assert result["access_token"] == "fixture"
    assert len(requests) == 1
    assert requests[0].url.path == "/session/token"
    for method, path in (("POST", "/orders/regular"), ("PUT", "/orders/regular/123"),
                         ("DELETE", "/session/token"), ("POST", "/session/token/extra")):
        with pytest.raises(RecoveryBlocked):
            asyncio.run(service._request_async(method, path))
    assert len(requests) == 1


def test_zerodha_sync_task_publication_and_consumer_use_isolated_queue(recovery, monkeypatch):
    app = RecoveryCelery("sync-test", broker="redis://localhost:6379/0",
                         backend="redis://localhost:6379/0", task_cls=RecoveryTask)
    configure_recovery_queue(app)
    published = []
    monkeypatch.setattr(Celery, "send_task", lambda self, name, **kwargs: published.append((name, kwargs)))
    def fixture_sync(user_id):
        return {"status": "completed"}
    task = app.task(name=ZERODHA_SYNC_TASK, shared=False)(fixture_sync)
    task.apply_async(args=[123], queue="ai", exchange="beat", routing_key="auto_live")
    assert published[0][0] == ZERODHA_SYNC_TASK
    assert all(published[0][1][key] == ANALYSIS_QUEUE for key in ("queue", "exchange", "routing_key"))
    task.before_start("fixture-task", [123], {})
    assert task(123) == {"status": "completed"}
    assert "app.domains.zerodha.tasks" in app.conf.imports
    with pytest.raises(RecoveryBlocked):
        app.send_task("app.domains.zerodha.tasks.enqueue_daily_portfolio_sync")
    assert len(published) == 1


def test_authenticated_zerodha_sync_http_flow_retains_containment(recovery, monkeypatch):
    from datetime import datetime, timedelta, timezone
    from unittest.mock import AsyncMock
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.domains.zerodha import router as routes
    app = FastAPI()
    app.add_middleware(RecoveryMiddleware)
    app.include_router(routes.router)
    db = SimpleNamespace(commit=AsyncMock())
    async def session(): yield db
    app.dependency_overrides[routes.get_async_db] = session
    app.dependency_overrides[routes.get_current_user] = lambda: SimpleNamespace(id=123)
    cred = SimpleNamespace(expires_at=datetime.now(timezone.utc)+timedelta(hours=1),
                           login_time=datetime.now(timezone.utc))
    monkeypatch.setattr(routes, "ZerodhaCredentialRepository", lambda _: SimpleNamespace(get_by_user=AsyncMock(return_value=cred)))
    monkeypatch.setattr(routes, "ZerodhaPortfolioSnapshotRepository", lambda _: SimpleNamespace(
        get_latest_by_user=AsyncMock(return_value=None), list_by_user=AsyncMock(return_value=[])))
    monkeypatch.setattr(routes, "ZerodhaAuditRepository", lambda _: SimpleNamespace(log=AsyncMock()))
    monkeypatch.setattr(routes, "_svc", SimpleNamespace(is_configured=True, direct_market_orders_enabled=False,
                                                      get_login_url=lambda: "https://kite.zerodha.com/connect/login"))
    celery_app = routes.sync_portfolio_snapshot_task.app
    for key in ("task_queues", "task_default_queue", "task_default_exchange", "task_default_routing_key",
                "task_routes", "task_create_missing_queues", "broker_transport_options", "result_backend_transport_options",
                "beat_schedule", "task_always_eager", "worker_enable_remote_control", "imports"):
        monkeypatch.setitem(celery_app.conf, key, celery_app.conf.get(key))
    configure_recovery_queue(celery_app)
    published = []
    def publish(self, name, **kwargs):
        published.append((name, kwargs))
        return SimpleNamespace(id="fixture-sync-task")
    monkeypatch.setattr(Celery, "send_task", publish)
    with TestClient(app) as client:
        assert client.get("/zerodha/status").json()["connected"] is True
        assert client.get("/zerodha/login-url").json()["configured"] is True
        assert client.get("/zerodha/portfolio").json() == {"latest": None, "history": []}
        result = client.post("/zerodha/portfolio/sync")
        assert result.status_code == 200
        assert result.json()["status"] == "queued"
        assert result.json()["task_id"] == "fixture-sync-task"
        assert client.post("/zerodha/orders", json={}).status_code == 503
    assert len(published) == 1
    name, options = published[0]
    assert name == ZERODHA_SYNC_TASK
    assert list(options["args"]) == [123, "manual"]
    assert options["queue"] == ANALYSIS_QUEUE
    db.commit.assert_awaited_once()


@pytest.mark.parametrize("portfolio,market", [("indmoney_us", "us"), ("india", "india")])
def test_recovery_accepts_matching_equity_market_identity(recovery, portfolio, market):
    from app.core.recovery import require_equity_analysis
    require_equity_analysis(portfolio)
    require_equity_analysis(portfolio, {"kind": "equity_output_sources_v1", "market": market})
    with pytest.raises(RecoveryBlocked):
        require_equity_analysis(portfolio, {"kind": "equity_output_sources_v1", "market": "us" if market == "india" else "india"})
    with pytest.raises(RecoveryBlocked):
        require_equity_analysis(portfolio, auto_export=True)


def test_zerodha_threats_http_request_creates_an_isolated_india_job(recovery, monkeypatch):
    from contextlib import asynccontextmanager
    from datetime import date, datetime, timezone
    from unittest.mock import AsyncMock
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.domains.zerodha import threats_router as routes
    from app.domains.jobs.use_cases import create_job as producer
    from app.domains.jobs.tasks import execute_ai_job
    from app.domains.auth.dependencies import get_current_user
    from app.infrastructure.database.session import get_async_db
    now = datetime.now(timezone.utc)
    snapshot = SimpleNamespace(snapshot_date=date.today(), captured_at=now)
    jobs, publications = [], []
    class Repo:
        def __init__(self, db): pass
        async def create(self, job):
            job.id, job.created_at = 123, now
            jobs.append(job)
        async def get(self, job_id): return jobs[0]
    class Lock:
        def __init__(self, *args): pass
        @asynccontextmanager
        async def acquire(self, *args, **kwargs): yield None
    monkeypatch.setattr(producer, "PostgresJobRepository", Repo)
    monkeypatch.setattr(producer, "register_job_task", AsyncMock())
    monkeypatch.setattr(routes, "PostgresJobRepository", Repo)
    monkeypatch.setattr(routes, "ZerodhaPortfolioSnapshotRepository", lambda _: SimpleNamespace(get_latest_by_user=AsyncMock(return_value=snapshot)))
    monkeypatch.setattr(routes, "_resolve_threat_target", AsyncMock(return_value=("fixture-provider", "fixture-model")))
    monkeypatch.setattr(routes, "build_zerodha_threat_prompt", lambda _: "Fixture Zerodha threats prompt")
    monkeypatch.setattr(routes, "_get_redis", lambda: SimpleNamespace(aclose=AsyncMock()))
    monkeypatch.setattr(routes, "RedisLock", Lock)
    monkeypatch.setattr(routes, "IdempotencyStore", lambda _: SimpleNamespace())
    monkeypatch.setattr(routes, "event_bus", SimpleNamespace(publish=AsyncMock()))
    app = FastAPI()
    app.add_middleware(RecoveryMiddleware)
    app.include_router(routes.router)
    db = SimpleNamespace(add=lambda _: None, commit=AsyncMock())
    async def session(): yield db
    app.dependency_overrides[get_async_db] = session
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=123)
    celery_app = execute_ai_job.app
    for key in ("task_queues", "task_default_queue", "task_default_exchange", "task_default_routing_key",
                "task_routes", "task_create_missing_queues", "broker_transport_options", "result_backend_transport_options",
                "beat_schedule", "task_always_eager", "worker_enable_remote_control", "imports"):
        monkeypatch.setitem(celery_app.conf, key, celery_app.conf.get(key))
    configure_recovery_queue(celery_app)
    def publish(self, name, **kwargs):
        publications.append((name, kwargs))
        return SimpleNamespace(id="fixture-threat-task")
    monkeypatch.setattr(Celery, "send_task", publish)
    with TestClient(app) as client:
        result = client.post("/zerodha/threats/run", json={
            "auto_rebalance_portfolio": "india", "auto_rebalance_sequence": 12,
            "auto_rebalance_label": "Zerodha Run 12 (threats)",
        })
        assert result.status_code == 200, result.text
        assert result.json()["job_id"] == 123
    assert jobs[0].auto_rebalance_portfolio == "india"
    assert jobs[0].auto_rebalance_sequence == 12
    assert publications[0][0] == ANALYSIS_TASK
    assert publications[0][1]["queue"] == ANALYSIS_QUEUE
    db.commit.assert_awaited_once()
