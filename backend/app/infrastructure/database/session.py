from collections.abc import AsyncGenerator
from time import monotonic

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.request_timing import add_database_duration

# ── Async engine (FastAPI / HTTP path) ──────────────────────────────────────
# Requires postgresql+asyncpg:// URL. We normalise here so callers keep a
# plain postgresql:// value in the environment.
_async_url = settings.database_url.replace(
    "postgresql://", "postgresql+asyncpg://", 1
).replace(
    "postgresql+psycopg2://", "postgresql+asyncpg://", 1
)

async_engine = create_async_engine(
    _async_url,
    pool_size=20,
    max_overflow=40,
    pool_timeout=30,
    pool_pre_ping=True,
    echo=settings.debug,
)


@event.listens_for(async_engine.sync_engine, "before_cursor_execute")
def _before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
    del cursor, statement, parameters, executemany
    context._investor_query_started_at = monotonic()


@event.listens_for(async_engine.sync_engine, "after_cursor_execute")
def _after_cursor_execute(conn, cursor, statement, parameters, context, executemany):
    del conn, cursor, statement, parameters, executemany
    started_at = getattr(context, "_investor_query_started_at", None)
    if started_at is not None:
        add_database_duration((monotonic() - started_at) * 1000)

AsyncSessionLocal = async_sessionmaker(
    async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_async_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session
