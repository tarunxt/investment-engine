"""Owner-bound SQL snapshot and compare-and-swap persistence."""
from dataclasses import dataclass
from datetime import datetime
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from .models import UserModule, UserModulePreferences
from .registry import ModuleConfigV1, ModuleId, REGISTRY


@dataclass
class SelectionSnapshot:
    owner_id: int
    version: int
    rows: dict[ModuleId, UserModule]
    persisted: bool = False

    def selected(self, id: ModuleId) -> bool:
        return id in self.rows and self.rows[id].enabled


def conflict():
    return HTTPException(409, {'code': 'MODULE_VERSION_CONFLICT', 'message': 'Module selections changed; reload before retrying'})


async def read_snapshot(db, owner_id: int) -> SelectionSnapshot:
    # One statement gives an internally consistent header/selection version,
    # including under READ COMMITTED concurrent PATCH requests.
    rows = (await db.execute(select(UserModulePreferences.version, UserModule)
        .outerjoin(UserModule, UserModule.user_id == UserModulePreferences.user_id)
        .where(UserModulePreferences.user_id == owner_id))).all()
    if not rows:
        return SelectionSnapshot(owner_id, 0, {})
    version = rows[0][0]
    selections = {}
    try:
        for row_version, row in rows:
            if row_version != version or version < 0:
                raise ValueError('Invalid aggregate version')
            if row is None:
                continue
            id = ModuleId(row.module_id)
            if id not in REGISTRY or row.user_id != owner_id or not 0 < row.version <= version:
                raise ValueError('Invalid owner or version')
            ModuleConfigV1.model_validate(row.config)
            selections[id] = row
    except (ValueError, ValidationError, TypeError):
        raise HTTPException(503, {'code': 'MODULE_STATE_UNAVAILABLE'}) from None
    return SelectionSnapshot(owner_id, version, selections, persisted=True)


async def claim_version(db, snapshot: SelectionSnapshot, expected: int) -> int:
    if snapshot.version != expected:
        raise conflict()
    next_version = expected + 1
    if not snapshot.persisted:
        dialect = db.get_bind().dialect.name
        insert = {'postgresql': pg_insert, 'sqlite': sqlite_insert}.get(dialect)
        if insert is None:
            raise HTTPException(503, {'code': 'MODULE_STORAGE_UNAVAILABLE'})
        # A single INSERT/CAS starts the actual outer transaction on both
        # PostgreSQL and SQLite. Releasing a first SQLite SAVEPOINT can commit
        # its header under legacy driver transaction mode, breaking rollback.
        inserted = (await db.execute(insert(UserModulePreferences).values(
            user_id=snapshot.owner_id, version=next_version, updated_at=datetime.utcnow())
            .on_conflict_do_nothing(index_elements=[UserModulePreferences.user_id])
            .returning(UserModulePreferences.version))).scalar_one_or_none()
        if inserted is None:
            raise conflict()
    else:
        result = await db.execute(update(UserModulePreferences).where(
            UserModulePreferences.user_id == snapshot.owner_id,
            UserModulePreferences.version == expected).values(
                version=next_version, updated_at=datetime.utcnow()))
        if result.rowcount != 1:
            raise conflict()
    return next_version
