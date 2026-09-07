"""Load full export snapshots outside the async HTTP event loop."""
from sqlalchemy import select

from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord
from app.domains.polymarket_auto_live.repository import record_to_run
from app.domains.polymarket_auto_live.stage_one_excel import build_stage_one_excel
from app.infrastructure.database.sync_session import SyncSessionLocal


def build_owned_stage_one_excel(user_id: int, run_id: str, scope: str):
    # JSON decoding and Pydantic validation can be substantial for a full
    # universe. Keep both inside the thread, not merely the workbook writer.
    with SyncSessionLocal() as session:
        record = session.execute(
            select(PolymarketAutoLiveRunRecord).where(
                PolymarketAutoLiveRunRecord.id == run_id,
                PolymarketAutoLiveRunRecord.user_id == user_id,
            )
        ).scalar_one_or_none()
        if record is None:
            raise ValueError("Auto-Live run not found.")
        run = record_to_run(record)
    return build_stage_one_excel(run, scope, True)
