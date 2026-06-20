import os

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.polymarket.router import _http_error_detail as bullpen_http_error_detail
from app.domains.polymarket_direct.router import (
    _http_error_detail as direct_http_error_detail,
)


def test_http_error_detail_includes_exception_type_and_message():
    detail = bullpen_http_error_detail(RuntimeError("Bullpen claim rejected"))
    assert detail == "RuntimeError: Bullpen claim rejected"


def test_http_error_detail_handles_empty_exception_messages():
    detail = direct_http_error_detail(RuntimeError())
    assert detail.startswith("RuntimeError:")
