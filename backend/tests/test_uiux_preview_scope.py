"""Local preview delegates actual owner-scoped projection, never fixed balances."""
from types import SimpleNamespace
import importlib
import pytest
from fastapi import FastAPI

@pytest.mark.asyncio
async def test_preview_summary_passes_authenticated_owner_and_request_session(monkeypatch):
    monkeypatch.setenv('STAGE01_PREVIEW','synthetic-only')
    module=importlib.import_module('scripts.public_launch.preview_stage08')
    calls=[]
    async def scoped(*,current_user,db):
        calls.append((current_user.id,db))
        return {'owned_projection':current_user.id}
    monkeypatch.setattr(module.fake,'dashboard',scoped)
    app=FastAPI();module.install(app)
    route=next(row for row in app.routes if getattr(row,'path',None)=='/dashboard/summary')
    session=object()
    assert await route.endpoint(user=SimpleNamespace(id=7102),db=session)=={'owned_projection':7102}
    assert calls==[(7102,session)]
