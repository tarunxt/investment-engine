"""Recognize transient database outages without masking application bugs."""
from sqlalchemy.exc import DBAPIError, TimeoutError as PoolTimeout


def database_is_unavailable(exc: BaseException) -> bool:
    seen = set()
    pending = [exc]
    while pending:
        error = pending.pop()
        if id(error) in seen:
            continue
        seen.add(id(error))
        sqlstate = getattr(error, "sqlstate", None) or getattr(error, "pgcode", None)
        if isinstance(error, PoolTimeout) or (
            isinstance(sqlstate, str)
            and (sqlstate.startswith("08") or sqlstate in {"57P01", "57P02", "57P03", "53300"})
        ) or (isinstance(error, DBAPIError) and error.connection_invalidated):
            return True
        pending.extend(e for e in (getattr(error, "orig", None), error.__cause__) if isinstance(e, BaseException))
        pending.extend(getattr(error, "exceptions", ()))
    return False
