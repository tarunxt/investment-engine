from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

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

AsyncSessionLocal = async_sessionmaker(
    async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_async_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session

