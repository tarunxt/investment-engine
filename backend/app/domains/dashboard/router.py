from __future__ import annotations

from hashlib import sha256
import json

from fastapi import APIRouter, Depends, Header, Response
from app.infrastructure.database.session import get_async_db
from fastapi.responses import Response as FastAPIResponse

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.polymarket.access import user_can_access_singleton_bullpen_runtime
from app.domains.dashboard.schemas import DashboardSummaryResponse
from app.domains.dashboard.service import build_dashboard_summary

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary", response_model=DashboardSummaryResponse)
async def get_dashboard_summary(
    response: Response,
    current_user: User = Depends(get_current_user),
    db=Depends(get_async_db),
    if_none_match: str | None = Header(default=None),
):
    from app.domains.modules.visibility import visible_module_ids
    module_ids=await visible_module_ids(db,current_user.id)
    summary = await build_dashboard_summary(
        current_user.id,
        module_ids=module_ids,
        include_singleton_bullpen=user_can_access_singleton_bullpen_runtime(
            current_user
        ),
    )
    etag_payload = summary.model_dump(mode="json")
    etag_payload.pop("generated_at", None)
    for section_meta in etag_payload.get("sections", {}).values():
        section_meta.pop("duration_ms", None)
    canonical_payload = json.dumps(
        etag_payload,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    etag = f'"{sha256(canonical_payload).hexdigest()}"'
    private_headers = {
        "Cache-Control": "private, no-cache, max-age=0, must-revalidate",
        "ETag": etag,
        "Vary": "Authorization, Cookie",
    }
    if if_none_match == etag:
        return FastAPIResponse(status_code=304, headers=private_headers)
    response.headers.update(private_headers)
    return summary
