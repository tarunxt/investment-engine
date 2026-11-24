from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from app.domains.scorecards import board, custom, router, storage
from app.domains.scorecards.final import calculate_final, policy
from test_auto_rebalance_audit_durability import audit_db, anyio_backend

KEY = "custom-" + "a" * 32
DEFINITION = dict(id=KEY, name="Liquidity", summary="Liquidity score", sources=["listings"],
                  inputs="Use the frozen listing.", prompt="Evaluate the price evidence.",
                  columns=["Listing","Score /100","Rationale"], target={"provider":"test","model":"model"})


@pytest.mark.anyio
async def test_migrate_install_save_and_isolate(audit_db):
    async with audit_db.sessions() as db:
        old = {"rebalance":55.25, "technical":30, "threats":9.75, "pairwise":5}
        await storage.append(db, 7001, "final", "old", {"result":{"policy":{"weights":old}}})
        await db.commit()
        assert (await board.read_board(db,7))["weights"] == old
        assert (await board.read_board(db,8))["enabled"] == []
        added = await board.save_board(db,8,board.BoardChange(version=0,add="technical",weights={"technical":100}))
        assert added["enabled"] == ["technical"]
        request = board.BoardChange(version=added["version"],add=KEY,definition=DEFINITION,
                                   weights={"technical":65.25,KEY:34.75})
        saved = await board.save_board(db,8,request)
        assert saved["enabled"] == ["technical", KEY]
        assert saved["custom"] == [DEFINITION]
        with pytest.raises(HTTPException,match="board changed"):
            await board.save_board(db,8,request)
        assert await board.read_board(db,8) == saved
        assert (await board.read_board(db,7))["custom"] == []
        assert (await board.read_board(db,8,"indmoney_us"))["custom"] == []
        assert (await board.present(db,8,saved))["latest"] == {}
        with pytest.raises(HTTPException,match="every enabled"):
            await board.save_board(db,8,board.BoardChange(version=saved["version"],add="threats",weights={"threats":100}))
    with pytest.raises(ValidationError):
        board.BoardChange(version=0,add="pairwise",weights={"pairwise":99.99})


@pytest.mark.anyio
async def test_custom_workflow_dispatch_pin_result_and_allocate(audit_db,monkeypatch):
    owner=SimpleNamespace(id=7)
    stock={"listing":"NSE:A","units":1,"settled":1,"price":60}
    manifest={"market":"india","as_of":"2026-01-02T10:00:00Z","stocks":[stock],"evidence":[]}
    async with audit_db.sessions() as db:
        current=await board.save_board(db,7,board.BoardChange(version=0,add=KEY,definition=DEFINITION,weights={KEY:100}))
        rev=await storage.append(db,7001,"revision","source",{"manifest":manifest,"digest":"hash"})
        mock=AsyncMock(return_value=SimpleNamespace(id=54))
        monkeypatch.setattr(custom.CreateRunUseCase,"execute",mock)
        monkeypatch.setattr(router,"_get_redis",lambda:AsyncMock())
        launch=custom.Launch(sequence=42,board_version=current["version"])
        started=await custom.start(db,owner,rev.id,KEY,launch)
        command=mock.await_args.args[0]
        assert command.scorecard_batches[0]["scorecard_batch"]["custom_columns"] == DEFINITION["columns"]
        assert command.auto_rebalance_sequence==42 and command.user_id==7 and command.auto_rebalance_portfolio=="india"
        assert 'Evaluate the price evidence.' in command.prompt and 'NSE:A' in command.prompt and '"positions"' not in command.prompt
        doc=await storage.lookup(db,7,"india","attempt",started["id"])
        assert doc.data["settings"]["definition"]==DEFINITION
        assert (await custom.start(db,owner,rev.id,KEY,launch))["id"]==started["id"]
        mock.assert_awaited_once()
        job=SimpleNamespace(id=71,status="completed",response="| Listing | Score /100 | Rationale |\n|---|---|---|\n| NSE:A | 70 | Supported |")
        monkeypatch.setattr(router,"observations",AsyncMock(return_value=[(job,0,["NSE:A"],[],None)]))
        output=await router.attempt_result("india",doc.id,db,owner)
        assert output["rows"][0]["score"]==70 and output["rows"][0]["output"]["Rationale"]=="Supported"
        weights={**dict.fromkeys(board.CARDS,0),KEY:100}
        final=await router.finalize("india",rev.id,router.Finalize(sequence=42,weights=weights,attempts={KEY:doc.id}),db,owner)
        assert final["rows"][0]["final"]==70 and final["rows"][0]["contributions"][KEY]==70
        assert final["attempts"]=={KEY:doc.id}
        shown=await board.present(db,7,current)
        assert shown["latest"][KEY]["id"]==doc.id
        assert (await router.saved_policy("india",db,owner))["weights"]==weights


def test_incomplete_custom_evidence_and_methodologies():
    stocks=[{"listing":"NSE:A","settled":1,"units":1},{"listing":"NSE:B","settled":0,"units":0}]
    manifest={"stocks":stocks}
    rows="| Listing | Score /100 | Rationale |\n|---|---|---|\n| NSE:A | 0 | Observed |\n| NSE:B | 90 | One |\n| NSE:B | 95 | Two |"
    projected=custom.project(DEFINITION,manifest,[(SimpleNamespace(id=2,status="completed",response=rows),0,["NSE:A","NSE:B"],[],None)])
    assert [r["score"] for r in projected["rows"]]==[0,None] and projected["errors"]
    weights={**dict.fromkeys(board.CARDS,0),"rebalance":50,KEY:50}
    outputs={"rebalance":{"rows":[{"listing":s["listing"],"score":80,"coverage":"Complete"} for s in stocks]},KEY:projected}
    final=calculate_final(manifest,outputs,policy(weights,{},custom_cards=[KEY]))
    assert [(r["final"],r["available_weight"],r["status"]) for r in final]==[(40,100,"Complete"),(80,50,"Provisional")]
    for key in board.CARDS:
        method=board.methodology(key)
        assert method["inputs"] and method["prompt"] and method["columns"]
        assert "[INDEPENDENT_SCORECARD" not in method["prompt"]
