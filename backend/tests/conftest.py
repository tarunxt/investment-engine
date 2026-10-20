import os
import pytest


os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("OPENAI_API_KEY", "test-openai-key")
os.environ.setdefault("GEMINI_API_KEY", "test-gemini-key")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-anthropic-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-deepseek-key")


@pytest.fixture(autouse=True)
def isolate_api_usage_telemetry(monkeypatch):
    """Existing mocked provider tests must not open a real telemetry database.

    Ledger tests explicitly restore persistence against their in-memory DB.
    """
    from app.domains.api_usage import metering

    monkeypatch.setattr(metering, "_persist_attempt", lambda values: None)


@pytest.fixture
def synthetic_operator_unit_context(monkeypatch, request):
    """Unit-test admitted operator logic; real admission is tested in Stage05.

    Existing detached bot/projection/worker fixtures have no users database.
    They opt in explicitly, while HTTP/SQL negative tests never use this.
    """
    request.getfixturevalue("synthetic_module_unit_context")
    import importlib
    from unittest.mock import AsyncMock, Mock
    for domain, file in (
        ('polymarket','service'), ('polymarket_direct','service'),
        ('polymarket_auto_live','service'), ('trading_bots','service'),
        ('dashboard','service'), ('bullpen_trade_analysis','service'),
        ('trading_bots','tasks'), ('bullpen_trade_analysis','tasks'),
        ('polymarket_auto_live','tasks'), ('bullpen008','tasks'),
        ('polymarket_auto_live','order_intent_service'), ('polymarket_auto_live','export_tasks'),
    ):
        module=importlib.import_module(f'app.domains.{domain}.{file}')
        for name in ('require_operator_user_id','require_operator_user_id_sync','require_operator_intent_sync','require_operator_bullpen008_run_sync'):
            if hasattr(module,name):
                monkeypatch.setattr(module,name,AsyncMock() if name=='require_operator_user_id' else Mock())


@pytest.fixture
def synthetic_module_unit_context(monkeypatch):
    """Admitted context ONLY for explicit detached algorithm/adapter unit tests.

    Those tests use fake sessions/HTTP/providers and test their original domain
    contract. Real SQL/HTTP/lifecycle/worker negative tests never request this;
    Stage07 suites independently exercise admission and cancellation without it.
    """
    from contextlib import contextmanager,asynccontextmanager,nullcontext
    from types import SimpleNamespace
    from app.domains.modules import execution,lifecycle,tasks,dispatch
    identity=lifecycle.WorkIdentity(1,'zerodha_rebalance',1)
    context=SimpleNamespace(identity=identity,factory=lambda:nullcontext(SimpleNamespace()),async_factory=lambda:None)
    monkeypatch.setattr(execution,'_current',__import__('contextvars').ContextVar('synthetic_module_unit',default=context))
    monkeypatch.setattr(execution,'checkpoint',lambda:context)
    monkeypatch.setattr(execution,'require_bullpen_context',lambda *_:None)
    monkeypatch.setattr(execution,'resolve_effect_identity',lambda *_:identity)
    monkeypatch.setattr(execution,'effect_guard',lambda *a,**kw:nullcontext())
    @asynccontextmanager
    async def admitted_async(*a,**kw):yield
    monkeypatch.setattr(execution,'async_effect_guard',admitted_async)
    monkeypatch.setattr(execution,'bullpen_process_fence',admitted_async)
    monkeypatch.setattr(lifecycle,'current_sync',lambda *a,**kw:None)
    monkeypatch.setattr(lifecycle,'guard_job_transition',lambda *a,**kw:None)
    @contextmanager
    def admitted(*a,**kw):yield
    monkeypatch.setattr(tasks,'task_scope',admitted)
    monkeypatch.setattr(dispatch,'prepare_dispatch',lambda name,args,kwargs,options,**kw:options)
    monkeypatch.setattr(tasks,'closed_scheduler',lambda _:False)
    async def enqueue(db,owner,module,**kwargs):return lifecycle.WorkIdentity(owner,module,1)
    monkeypatch.setattr(lifecycle,'admit_enqueue',enqueue)
    async def transition(db,owner,workflow):return lifecycle.WorkIdentity(owner,'zerodha_rebalance',1)
    monkeypatch.setattr(lifecycle,'admit_workflow_transition',transition)
