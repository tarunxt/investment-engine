from __future__ import annotations

from datetime import UTC, datetime
import importlib.util
from pathlib import Path

import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "c6d7e8f9g0h1_recover_bullpen_auto_live_llm_targets.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "recover_bullpen_auto_live_llm_targets_migration",
        MIGRATION_PATH,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_upgrade_recovers_latest_historical_non_empty_target_selection(monkeypatch):
    migration = _load_migration()
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    settings = sa.Table(
        "polymarket_auto_live_settings",
        metadata,
        sa.Column("user_id", sa.Integer(), primary_key=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    runs = sa.Table(
        "polymarket_auto_live_runs",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(
            settings.insert(),
            [
                {
                    "user_id": 1,
                    "payload": {
                        "strategy_profile": "bullpen_console_top10",
                        "auto_live_enabled": True,
                        "console_llm_targets": [],
                    },
                },
                {
                    "user_id": 2,
                    "payload": {
                        "strategy_profile": "bullpen_console_top10",
                        "auto_live_enabled": True,
                        "console_llm_targets": [
                            {"provider": "openai", "model": "keep-current"}
                        ],
                    },
                },
                {
                    "user_id": 3,
                    "payload": {
                        "strategy_profile": "bullpen_console_top10",
                        "auto_live_enabled": True,
                        "console_llm_targets": [],
                    },
                },
            ],
        )
        connection.execute(
            runs.insert(),
            [
                {
                    "id": 11,
                    "user_id": 1,
                    "started_at": datetime(2026, 8, 10, tzinfo=UTC),
                    "payload": {
                        "stage2_llm_targets_snapshot": [],
                        "audit_metadata": {
                            "settings_snapshot": {"console_llm_targets": []}
                        },
                    },
                },
                {
                    "id": 10,
                    "user_id": 1,
                    "started_at": datetime(2026, 8, 9, tzinfo=UTC),
                    "payload": {
                        "stage2_llm_targets_snapshot": [
                            {"provider": " openai ", "model": " gpt-5 "},
                            {"provider": "openai", "model": "gpt-5"},
                            {"provider": "gemini", "model": "gemini-2.5-pro"},
                        ]
                    },
                },
                {
                    "id": 20,
                    "user_id": 2,
                    "started_at": datetime(2026, 8, 8, tzinfo=UTC),
                    "payload": {
                        "stage2_llm_targets_snapshot": [
                            {"provider": "anthropic", "model": "old-model"}
                        ]
                    },
                },
                {
                    "id": 30,
                    "user_id": 3,
                    "started_at": datetime(2026, 8, 8, tzinfo=UTC),
                    "payload": {
                        "audit_metadata": {
                            "settings_snapshot": {"console_llm_targets": []}
                        }
                    },
                },
            ],
        )

        monkeypatch.setattr(migration.op, "get_bind", lambda: connection)
        migration.upgrade()

        rows = {
            row.user_id: row.payload
            for row in connection.execute(
                sa.select(settings.c.user_id, settings.c.payload)
            )
        }

    assert rows[1]["console_llm_targets"] == [
        {"provider": "openai", "model": "gpt-5"},
        {"provider": "gemini", "model": "gemini-2.5-pro"},
    ]
    assert rows[2]["console_llm_targets"] == [
        {"provider": "openai", "model": "keep-current"}
    ]
    assert rows[3]["console_llm_targets"] == []
