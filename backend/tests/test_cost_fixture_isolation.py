"""Exercise shared conftest with a genuine unrelated pytest module."""
from pathlib import Path
import os
import subprocess
import sys


def test_non_cost_module_runs_without_cost_ledger(tmp_path):
    tests = Path(__file__).resolve().parent
    (tmp_path / "conftest.py").write_bytes((tests / "conftest.py").read_bytes())
    (tmp_path / "test_unrelated.py").write_text("def test_unrelated():\n    assert True\n")
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", str(tmp_path / "test_unrelated.py"),
         "--basetemp", str(tmp_path / "pytest-temp")],
        cwd=tmp_path, capture_output=True, text=True, timeout=30,
        env={**os.environ, "PYTHONPATH": str(tests.parent),
             "DATABASE_URL": "postgresql+asyncpg://fixture:fixture@127.0.0.1:1/fixture",
             "REDIS_URL": "redis://127.0.0.1:1/0"},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "1 passed" in result.stdout
    assert not list((tmp_path / "pytest-temp").rglob("collection-intents.db"))
