from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.domains.auth.models import User
from app.domains.runs.models import Run
from app.domains.scorecards import pair_evidence, pair_plan, pair_work, router, storage
from app.domains.scorecards.technical_sources import resolve_history_instruments
from test_pairwise_recovery import sample, votes
from test_auto_rebalance_audit_durability import audit_db, anyio_backend


def test_exact_venue_alias_requires_corroboration():
    rows=[{"listing":"NSE:M_M","name":"Mahindra & Mahindra Limited"}]
    master={"NSE:M&M":{"isin":"ONE","name":"Mahindra And Mahindra Ltd."},
            "BSE:M&M":{"isin":"TWO","name":"Mahindra And Mahindra Ltd."}}
    assert resolve_history_instruments(rows,master,{})=={"NSE:M_M":"NSE:M&M"}
    assert resolve_history_instruments([{**rows[0],"name":"Different issuer"}],master,{})=={}
    assert resolve_history_instruments([{**rows[0],"isin":"TWO"}],master,{})=={}


def test_missing_components_and_fair_quota_schedule():
    rows=[{"listing":"NSE:VEDL","ready":False,"sessions":60,"reason":"Corporate-action history unavailable"},
          {"listing":"NSE:M_M","ready":False,"sessions":0,"reason":"Corporate-action history unavailable · Exact venue instrument unavailable"}]
    work={"gaps":{}}
    pair_work.refresh_gaps(work,rows,100)
    assert work["gaps"]["NSE:VEDL"]["needs"] == ["corporate actions"]
    assert len(work["gaps"]["NSE:M_M"]["needs"])==3
    pair_work.refresh_gaps(work,rows,120,["NSE:VEDL"],600)
    assert pair_work.pending(work,130)==["NSE:M_M"]
    assert work["gaps"]["NSE:VEDL"]["next_retry"]==720


@pytest.mark.anyio
@pytest.mark.parametrize("budget",[None,20])
async def test_247_durable_dispatch_and_resume(audit_db,monkeypatch,budget):
    keys, manifest, research=sample(34,18)
    manifest.update(as_of="2026-11-22T15:01:00+00:00",market="india",sequence=42,evidence=[])
    for s in manifest["stocks"]:
        s.update(origin="holding")
    research.update(version=2,as_of=manifest["as_of"])
    waves=[]
    async def dispatch(self,cmd):
        attempt=await storage.lookup(self._session,7,"india","attempt",cmd.scorecard_attempt_id)
        waves.append(attempt.data["settings"]["assignments"])
        run=Run(user_id=7,prompt="fixture",prompt_preview="fixture",status="completed")
        self._session.add(run)
        await self._session.flush()
        attempt.row.run_id=run.id
        await self._session.commit()
        return run
    monkeypatch.setattr(router.CreateRunUseCase,"execute",dispatch)
    monkeypatch.setattr(router,"_get_redis",lambda:AsyncMock())
    monkeypatch.setattr(router,"build_prompt",lambda *args:"fixture")
    for packet in research["packets"].values():
        for source in packet["sources"].values(): source.update(url="fixture",as_of=manifest["as_of"])
    estimate=AsyncMock(return_value=2)
    monkeypatch.setattr(pair_evidence,"check_budget",estimate)
    async with audit_db.sessions() as db:
        rev=await storage.append(db,7001,"revision","r",{"manifest":manifest,"digest":"fixture"})
        await storage.append(db,7001,"packet","pairwise-v3",{"research":research},revision_id=rev.id)
        user=await db.get(User,7)
        request=router.Start(sequence=42,request_key="test",targets=[{"provider":"deepseek","model":"fixture"}],
                             estimated_budget_inr=budget,evidence_only=budget is None)
        started=await router.start("india",rev.id,"pairwise",request,db,user)
        work=await db.scalar(select(storage.Stage).where(storage.of_kind("pair_work",rev.id)))
        assert work and work.summary_json["budget"]==budget
        assert (await router.start("india",rev.id,"pairwise",request,db,user))==started
        root=await storage.lookup(db,7,"india","attempt",started["id"])
        if budget:
            assert [len(ps) for _,ps in waves[0]]==[24]*6+[9]
            with pytest.raises(HTTPException,match="already active"):
                await router.start("india",rev.id,"pairwise",request.model_copy(update={"request_key":"other"}),db,user)
            output=pair_plan.project_plan(manifest,research,"full",{"errors":[], "rows":votes(keys,18)},jobs=7)
            pair_evidence.finish(output,root,research,rev.id)
            await db.commit()
        else:
            assert started["run_id"] is None and not waves
        async def recover(session,original,owner,username,*,requested):
            assert 0<len(requested)<=6
            _,_,new=sample(34,34)
            packets={**research,"packets":new["packets"]}
            for k in keys[:18]: packets["packets"][k]=research["packets"][k]
            for k in keys[18:]: packets["packets"][k]["sources"]={"1":{"url":"fixture","as_of":manifest["as_of"]}}
            packet=await storage.append(db,7001,"packet","next-p",{"research":packets},revision_id=rev.id)
            child=await storage.append(db,7001,"attempt","next-a",{"card":"pairwise","settings":{
                **original.data["settings"],"packet_id":packet.id,"parent":None}},revision_id=rev.id)
            data=pair_plan.project_plan(manifest,packets,"full",{"errors":[]},original.result_json,research["packets"])
            out=pair_evidence.finish(data,child,packets,rev.id)
            await db.commit()
            return out
        monkeypatch.setattr(pair_evidence,"repair",recover)
        await pair_work.advance(db,work.id)
        await db.refresh(work)
        if budget:
            assert work.summary_json["phase"]=="judging",work.summary_json
            assert len(waves)==2 and sum(len(ps) for _,ps in waves[1])==408
            assert estimate.await_args.args[-1]==18
            assert not {tuple(p) for _,ps in waves[0] for p in ps}&{tuple(p) for _,ps in waves[1] for p in ps}
        else:
            assert work.status=="completed" and work.summary_json["phase"]=="awaiting judgments"
            assert not waves and estimate.await_count==0
        await pair_work.advance(db,work.id)
        assert len(waves)==(2 if budget else 0)
