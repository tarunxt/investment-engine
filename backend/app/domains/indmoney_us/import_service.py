"""Owned immutable previews, idempotent imports and explicit payload-bound acceptance."""
from datetime import datetime,timezone
from sqlalchemy import select,update
from sqlalchemy.exc import IntegrityError
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot as Snapshot
from app.domains.indmoney_us.import_validation import parse_import,content_digest
from app.shared.exceptions import ValidationException,NotFoundException,ConflictException

class ManualImportService:
    def __init__(self,db): self.db=db

    async def owned(self,owner,snapshot_id):
        row=await self.db.scalar(select(Snapshot).where(Snapshot.user_id==owner,Snapshot.id==snapshot_id))
        if row is None:raise NotFoundException('Manual import not found')
        return row

    async def preview(self,owner,request):
        if request.captured_at is None:raise ValidationException('Explicit as-of time is required for preview.')
        if request.supersedes_id is not None:
            prior=await self.owned(owner,request.supersedes_id)
            if prior.acceptance_state not in {'accepted','legacy_unverified'}:raise ValidationException('Correction must reference an accepted or legacy snapshot.')
        data=parse_import(request)
        existing=await self.db.scalar(select(Snapshot).where(Snapshot.user_id==owner,Snapshot.import_key==data['import_key']))
        if existing is not None:return existing
        try:
            async with self.db.begin_nested():
                row=Snapshot(user_id=owner,**data);self.db.add(row);await self.db.flush()
        except IntegrityError:
            row=await self.db.scalar(select(Snapshot).where(Snapshot.user_id==owner,Snapshot.import_key==data['import_key']))
            if row is None:raise
        return row

    async def accept(self,owner,snapshot_id,content_hash):
        row=await self.owned(owner,snapshot_id)
        data={key:getattr(row,key) for key in ('wallet_balance','current_value','invested_value','day_return_value','day_return_percent','total_return_value','total_return_percent','raw_text','snapshot_date','captured_at','source','holdings','market_indices','reported_holdings_count','import_provenance','supersedes_id','holdings_count','parse_status','parse_warnings','indices_count','dashboard_top_holdings')}
        if row.content_hash!=content_hash or content_digest(data)!=content_hash:raise ConflictException('Preview changed; review the exact content again.')
        if row.acceptance_state=='accepted':return row
        if row.acceptance_state!='preview' or (row.import_provenance or {}).get('errors'):raise ValidationException('Quarantined or legacy data cannot be accepted; create a corrected preview.')
        result=await self.db.execute(update(Snapshot).where(Snapshot.id==snapshot_id,Snapshot.user_id==owner,Snapshot.acceptance_state=='preview',Snapshot.content_hash==content_hash).values(acceptance_state='accepted',accepted_at=datetime.now(timezone.utc)).execution_options(synchronize_session=False))
        if result.rowcount!=1:raise ConflictException('Import state changed; refresh before accepting.')
        await self.db.refresh(row)
        return row
