import asyncio
from types import SimpleNamespace

import pytest
from celery import Celery, Task
from kombu.transport.redis import PrefixedStrictRedis

from app.core.recovery import (
    ANALYSIS_QUEUE, ANALYSIS_TASK, TRANSPORT_PREFIX, RecoveryBlocked,
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
    (None, None, False), ("india", None, False),
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
def test_indmoney_fanout_preserves_identity_and_uses_only_recovery_queue(recovery, monkeypatch, stage):
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
        prompt=f"Fixture INDmoney {stage}", targets=targets, user_id=2,
        auto_rebalance_portfolio="indmoney_us", auto_rebalance_sequence=7,
        auto_rebalance_label=f"INDmoney Run 7 ({stage})", allow_parallel=True,
        auto_export_enabled=True, export_sheet_name="requested-by-existing-ui",
    )))
    assert len(jobs) == len(publications) == 2
    assert run.auto_export_enabled is False
    assert run.export_status == "disabled"
    assert all(j.auto_rebalance_portfolio == "indmoney_us" and
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
    assert list(app.conf.task_routes) == [ANALYSIS_TASK]
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
    ("POST", "/zerodha/orders", False), ("POST", "/runs/123/cancel", False),
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
