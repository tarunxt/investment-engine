import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.domains.scorecards.coverage import summary
from app.domains.scorecards.evaluation import compare_dates
from app.domains.scorecards.pair_records import records
from app.domains.scorecards.prompts import build_prompt
from app.domains.scorecards.scoring import project
from app.domains.scorecards.signals import features, setup_state


def test_candles_are_dated_reproducible_and_scale_checked():
    start=datetime(2026,1,1,10,tzinfo=timezone.utc)
    bars=[{"kind":"daily_bar","as_of":(start+timedelta(days=i)).isoformat(),"open":100+i,
           "high":101+i,"low":99+i,"close":100+i,"volume":1000+i} for i in range(65)]
    cutoff=bars[59]["as_of"]
    f=features(bars,cutoff,bars)
    assert f["sessions"]==60 and f["relative_20_pct"]==0
    assert abs(f["return_5_pct"] - 100*(159/154-1))<1e-10
    assert f["shadow_score"] is not None and f["relative_volume_20"]>1
    assert features(bars[::-1],cutoff,bars)==f
    assert features(bars[:4],bars[3]["as_of"])["return_5_pct"] is None
    conflict={**bars[3],"volume":50}
    assert "Conflicting" in features(bars+[conflict],cutoff)["issue"]
    assert "Missing a recent" in features(bars[:58],cutoff,bars)["issue"]
    assert "scale" in features([bars[0],{**bars[1],"open":220,"high":223,"low":219,"close":221}],cutoff)["issue"]
    r={"Primary Setup":"Support bounce (7.8)","Bias":"Bullish","Trigger Level":"165","Invalidation Level":"150"}
    assert setup_state([r],f)["entry"]=="Waiting for trigger"
    assert setup_state([r],{**f,"close":166})["entry"]=="Triggered at close"
    assert setup_state([r],{**f,"close":148})["entry"]=="Invalidated"


def test_pair_records_repair_only_bad_pairs_and_exclude_reverse_audit_from_rank():
    keys=["NSE:A","NSE:B","NSE:C"]
    cutoff="2026-09-01T10:00:00+00:00"
    pairs=[(keys[0],keys[1]),(keys[0],keys[2])]
    packets={k:{"sources":{"1":{"url":"https://example.org/"+k,"as_of":cutoff}},"features":{}} for k in keys}
    def line(pair,winner):
        return json.dumps({"pair_id":"~".join(pair),"result":winner,"rationale":"Comparison","evidence":{k:["1"] for k in pair}})
    compact = json.dumps([1, keys[0], "Comparison", ["1"], ["1"]])
    assert records(compact, pairs, packets, cutoff) == records(line(pairs[0],keys[0]), pairs, packets, cutoff)
    assert not records(compact+"\n"+line(pairs[0],keys[0]), pairs, packets, cutoff)
    first=line(pairs[0],keys[0])
    assert len(records(first+"\n{broken",pairs,packets,cutoff))==1
    assert not records(first+"\n"+first,pairs,packets,cutoff)
    assert not records(first,pairs,{**packets,keys[1]:{}},cutoff)
    assert not records(first,pairs,packets,"2025-01-01T00:00:00Z")
    early=SimpleNamespace(id=2416,status="partial",response=first,prompt="[PAIR_RECORDS_V2]")
    audit=SimpleNamespace(id=2441,status="completed",response=line(pairs[0],keys[1]),prompt="[PAIR_RECORDS_V2]")
    research={"version":2,"packets":packets,"listings":{}}
    manifest={"stocks":[{"listing":k} for k in keys],"as_of":cutoff}
    output=project("pairwise",manifest,[(early,0,keys,pairs,research),(audit,0,keys,pairs[:1],{**research,"order_check":True})])
    assert output["rows"][0]["score"]==100 and summary("pairwise",output["rows"])==(1,3)
    assert output["order_checks"][0]["agreed"] is False


def test_empty_horizons_remain_unknown_and_costs_reduce_portfolio_returns():
    base=datetime(2025,1,1)
    days=[(base+timedelta(days=i)).date().isoformat() for i in range(75) if (base+timedelta(days=i)).weekday()<5]
    prices={k:{d:{"open":100,"close":100} for d in days} for k in ("NSE:A","NSE:NIFTYBEES")}
    decisions=[{"sequence":244,"day":"2024-12-31","weights":[22,1],
                "signals":{"NSE:A":{"current":90,"revised":80,"pairwise":100}}}]
    result=compare_dates(decisions,prices,1,10)
    assert result[0]["matured_cohorts"]==1 and -.21<result[0]["mean_net_pct"]<-.19
    assert result[-1]["mean_net_pct"] is None


from test_auto_rebalance_audit_durability import audit_db, anyio_backend
from app.domains.scorecards import storage
from app.domains.scorecards.coverage import available
import pytest


@pytest.mark.anyio
async def test_saved_output_and_consumed_output_have_separate_identities(audit_db):
    async with audit_db.sessions() as db:
        rev=await storage.append(db,7001,"revision","test",{"manifest":{}})
        async def add(name,rows):
            return await storage.append(db,7001,"attempt",name,{"card":"technical","result":{"rows":rows}},revision_id=rev.id)
        empty=await add("empty",[{"score":None},{"score":None}])
        complete=await add("success",[{"score":0},{"score":90}])
        await add("cancelled",[])
        final=await storage.append(db,7001,"final","final",{"result":{"attempts":{"technical":empty.id}}},revision_id=rev.id)
        await db.commit()
        saved=await available(db,7,"india",42)
        assert saved["cards"]["technical"]=={"covered":2,"expected":2,"output_id":complete.id,
                 "used_output_id":empty.id,"run_id":None,"final_id":final.id}
        assert (await available(db,8,"india",42))["cards"]=={}


def test_single_job_assignments_cover_full_universe_and_only_unresolved_pairs():
    from itertools import combinations
    from app.domains.scorecards.prompts import batches

    keys = [f"NSE:S{i:02}" for i in range(16)]
    stocks = [{"listing": k} for k in reversed(keys)]
    expected = list(combinations(keys, 2))
    rebalance_keys = [f"NSE:R{i:02}" for i in range(34)]
    rebalance_stocks = [{"listing": key} for key in rebalance_keys]
    assert list(batches(rebalance_stocks, "rebalance", portfolio="india")) == [(rebalance_keys, [])]
    assert len(list(batches(rebalance_stocks, "rebalance", portfolio="indmoney_us"))) == 3
    assert list(batches(stocks, "threats", portfolio="india")) == [(keys, [])]
    assert list(batches(stocks, "pairwise", portfolio="india")) == [(keys, expected)]
    unresolved = expected[12:42]
    assert list(batches(stocks, "pairwise", pairs=unresolved, portfolio="india")) == [
        (sorted({key for pair in unresolved for key in pair}), unresolved)]
    assert len(list(batches(stocks, "threats", portfolio="indmoney_us"))) == 4
    assert len(list(batches(stocks, "pairwise", portfolio="indmoney_us"))) == 5


async def exercise_single_job_start(monkeypatch, card):
    from unittest.mock import AsyncMock
    import pytest
    from fastapi import HTTPException
    from app.domains.scorecards import router

    keys = [f"NSE:S{i:02}" for i in range(16)]
    stocks = [dict(listing=k, symbol=k[4:], exchange="NSE", units=1, origin="holding") for k in keys]
    rev = SimpleNamespace(id=1, digest="fixture", manifest=dict(stocks=stocks, market="india",
                          as_of="2026-11-21T12:00:00Z", evidence=[]))
    evidence = {"version":2, "packets":{k:{"features":{}, "sources":{}} for k in keys}}
    if card=="rebalance":
        from app.domains.scorecards import rebalance_evidence
        evidence={"version":4,"packets":{k:{"refs":{},"allowed":{}} for k in keys}}
        monkeypatch.setattr(rebalance_evidence, "collect", AsyncMock(return_value=evidence))
    monkeypatch.setattr(router, "owned", AsyncMock(return_value=rev))
    monkeypatch.setattr(router.storage, "by_key", AsyncMock(return_value=None))
    history={"technical":{}}
    for packet in evidence["packets"].values():
        packet.update(features={"return_5_pct":1.0,"sessions":60},sources={"1":{"url":"https://example.test/quote","as_of":rev.manifest["as_of"]}})
    monkeypatch.setattr(router.pair_evidence,"latest_history",AsyncMock(return_value=history))
    monkeypatch.setattr(router.pair_evidence,"reconcile",lambda *args:evidence)
    monkeypatch.setattr(router.pair_evidence,"news",AsyncMock(return_value={}))
    monkeypatch.setattr(router.pair_evidence,"save_history",AsyncMock())
    monkeypatch.setattr(router, "collect_research", AsyncMock(return_value={}))
    monkeypatch.setattr(router, "workflow", AsyncMock(return_value=SimpleNamespace(id=2, sequence=5, label="Test")))
    monkeypatch.setattr(router.storage, "append", AsyncMock(return_value=SimpleNamespace(id=3, data={"research":evidence})))
    monkeypatch.setattr(router, "_get_redis", lambda: AsyncMock())
    enqueue = AsyncMock(return_value=SimpleNamespace(id=10))
    monkeypatch.setattr(router.CreateRunUseCase, "execute", enqueue)
    user = SimpleNamespace(id=1, username="test")
    target = dict(provider="deepseek", model="deepseek-v4-flash")
    def body(targets, check=False):
        return router.Start(request_key="fixture", sequence=5, targets=targets, check_pair_order=check)

    if card == "rebalance":
        await router.start("india", rev.id, card, body([target, target]), AsyncMock(), user)
        command, = enqueue.await_args.args
        assert len(command.targets) == 2
        assert len(command.batch_prompts) == len(command.scorecard_batches) == 1
        assert command.scorecard_batches[0]["scorecard_batch"]["listings"] == keys
        assert command.allow_parallel and not command.stagger_gemini
        return
    with pytest.raises(HTTPException, match="exactly one"):
        await router.start("india", rev.id, card, body([target,target]), AsyncMock(), user)
    if card == "pairwise":
        with pytest.raises(HTTPException, match="reversed-order"):
            await router.start("india", rev.id, card, body([target], True), AsyncMock(), user)
    enqueue.assert_not_awaited()
    await router.start("india", rev.id, card, body([target]), AsyncMock(), user)
    command, = enqueue.await_args.args
    assert len(command.targets)==1
    assert len(command.batch_prompts)==len(command.scorecard_batches)==(5 if card=="pairwise" else 1)
    assignment = command.scorecard_batches[0]["scorecard_batch"]
    if card=="pairwise":
        assert sum(len(b["scorecard_batch"]["pairs_v2"]) for b in command.scorecard_batches)==120
    else:
        assert assignment["listings"]==keys


def test_scorecard_start_dispatches_exactly_one_job_per_india_card(monkeypatch):
    import asyncio
    for card in ("rebalance", "threats", "pairwise"):
        asyncio.run(exercise_single_job_start(monkeypatch, card))


def _wait_for_sibling(directory, slot):
    """Both model slots must start before either may finish."""
    from pathlib import Path
    from time import monotonic, sleep

    root = Path(directory)
    (root / str(slot)).touch()
    deadline = monotonic() + 5
    while not (root / str(1 - slot)).exists():
        if monotonic() >= deadline:
            return False
        sleep(0.01)
    return True


def test_recovery_worker_executes_two_slots_concurrently(monkeypatch, tmp_path):
    from app.infrastructure.messaging.recovery_celery import RecoveryCelery
    from app.core.recovery import ANALYSIS_QUEUE

    monkeypatch.setenv("CREDX_RECOVERY_MODE", "1")
    app = RecoveryCelery("scorecard-test", broker="memory://", backend="cache+memory://",
                         set_as_current=False)
    worker = app.Worker(pool_cls="solo", concurrency=1, queues=[ANALYSIS_QUEUE],
                        use_eventloop=False, quiet=True)
    assert worker.min_concurrency == 2
    assert worker.max_concurrency == 8
    worker.pool.start()
    try:
        jobs = [worker.pool.apply_async(_wait_for_sibling, (str(tmp_path), slot)) for slot in (0, 1)]
        assert all(job.get(timeout=10) for job in jobs)
    finally:
        worker.pool.terminate()
        app.close()
