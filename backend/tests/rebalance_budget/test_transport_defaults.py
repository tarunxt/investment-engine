"""Pinned SDK contracts only; no client creation, credentials or network calls."""
import inspect
from importlib.metadata import version

from anthropic import _constants as anthropic_constants
from openai import _constants as openai_constants
from google.genai import types
from google.genai._api_client import retry_args
from tavily import TavilyClient


def test_installed_sdk_versions_match_reviewed_transport_contract():
    assert version("openai") == "2.35.1"
    assert version("anthropic") == "0.100.0"
    assert version("google-genai") == "2.0.1"
    assert version("tavily-python") == "0.7.24"


def test_openai_deepseek_anthropic_hidden_retries_and_timeouts_are_not_zero():
    # These are defaults inherited by the existing constructors, not a promise
    # that timeout cancels billed work or caps the entire generation deadline.
    for constants in (openai_constants, anthropic_constants):
        assert constants.DEFAULT_MAX_RETRIES == 2
        assert constants.DEFAULT_TIMEOUT.connect == 5
        assert constants.DEFAULT_TIMEOUT.read == 600
        assert constants.DEFAULT_TIMEOUT.write == 600
        assert constants.DEFAULT_TIMEOUT.pool == 600


def test_google_absent_retry_options_do_not_mean_five_active_attempts():
    options = types.HttpOptions(api_version="v1alpha")
    assert options.retry_options is None and options.timeout is None
    args = retry_args(options.retry_options)
    assert args["stop"].max_attempt_number == 1
    # Explicitly supplied default retry options are different from absent ones.
    assert retry_args(types.HttpRetryOptions())["stop"].max_attempt_number == 5


def test_tavily_search_timeout_is_bounded_per_transport_not_workflow():
    assert inspect.signature(TavilyClient.search).parameters["timeout"].default == 60
    assert inspect.signature(TavilyClient._search).parameters["timeout"].default == 60


def test_new_refund_model_is_registered_by_canonical_catalog():
    import app.models
    from app.infrastructure.database.base import Base
    from app.domains.rebalance_budget.models import RebalanceSpendRefund
    assert Base.metadata.tables["rebalance_spend_refunds"] is RebalanceSpendRefund.__table__
    assert app.models.RebalanceSpendRefund is RebalanceSpendRefund


def test_refund_migration_matches_registered_metadata_without_running_alembic(monkeypatch):
    import importlib.util
    from pathlib import Path
    from types import SimpleNamespace
    from app.domains.rebalance_budget.models import RebalanceSpendAttempt, RebalanceSpendRefund
    source = Path(__file__).resolve().parents[2] / "alembic/versions/rebalance_spend_refund_002.py"
    spec = importlib.util.spec_from_file_location("synthetic_refund_migration", source)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    tables, columns = {}, {}
    monkeypatch.setattr(migration, "op", SimpleNamespace(
        create_table=lambda name, *items: tables.setdefault(name, items),
        add_column=lambda name, column: columns.setdefault(column.name, (name, column)),
    ))
    migration.upgrade()  # only the in-memory operation recorder above executes
    assert migration.down_revision == "rebalance_spend_cap_001"
    recorded = {item.name: item for item in tables["rebalance_spend_refunds"] if hasattr(item, "nullable")}
    assert set(recorded) == set(RebalanceSpendRefund.__table__.columns.keys())
    for name, column in recorded.items():
        model = RebalanceSpendRefund.__table__.columns[name]
        assert str(column.type) == str(model.type) and column.nullable == model.nullable
    for name, (table, column) in columns.items():
        assert table == "rebalance_spend_attempts"
        model = RebalanceSpendAttempt.__table__.columns[name]
        assert str(column.type) == str(model.type) and model.nullable is True
