# Synthetic security, holdings, scores, prices and times; no user portfolio data.
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from app.domains.recommendation_audit.deterministic import calculate, compare, digest, action_for_score, sizing_layer
from app.domains.recommendation_audit.models import DecisionRecord, EvidenceRecord, SpendAccount, SpendAttempt, VerificationRecord
from app.domains.recommendation_audit.schemas import Formula, SCORE_FIELDS, VerificationCreate, Claim, Observation
from app.domains.recommendation_audit.service import create_verification, owned_decision, bundle, AuditConflict
from app.domains.recommendation_audit.worker import claim_lease, finish, run_verification
from app.domains.recommendation_audit.ledger import reserve, settle, BudgetBlocked
from app.domains.recommendation_audit.verdict import evaluate, candle_observations, claims_for
from app.domains.recommendation_audit.evaluation import sensitivity, walk_forward
from app.domains.recommendation_audit.technical import technical_rows

NOW = datetime(2024, 2, 1, 12, 0, tzinfo=timezone.utc)


def formula():
    f = Formula(detailedRationaleDenominator=20)
    f.detailedRationaleMultipliers["last-5-candles-trend"] = Decimal(0)
    return f


def sample(scores=(-1, -2, 1, 2, -1, 2), *, current=1, action="Sell All", change=-1, final=0, job=1):
    return {"row": dict(zip(SCORE_FIELDS, scores)) | {"action": action, "current_units": current, "units_change": change, "final_units": final}, "provider": "deepseek", "model": "fixture-model", "job_id": job, "valid": True}


@pytest.fixture
def db():
    # Full registry imports are required because existing Job/Run mappers share Base.
    import app.models
    from app.infrastructure.database.base import Base
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[m.__table__ for m in (EvidenceRecord, DecisionRecord, VerificationRecord, SpendAccount, SpendAttempt)])
    with Session(engine, expire_on_commit=False) as session: yield session
    engine.dispose()


def decision(db, *, user=1, day=0, data=None):
    data = data or {"market": "india", "symbol": "FIXTUREEQ", "exchange": "NSE", "formula_hash": "f", "calculation": calculate([sample()], formula()), "coverage": {"successful": 1, "attempted": 1}, "decision_at": NOW.isoformat(), "original_completion_at": NOW.isoformat()}
    obj = DecisionRecord(user_id=user, run_id=10+day, market="india", symbol="FIXTUREEQ", exchange="NSE", decision_at=NOW+timedelta(days=day), captured_at=NOW+timedelta(days=day), provenance="prospective", content_hash=digest({"data": data, "day": day, "user": user}), payload=data)
    db.add(obj); db.commit(); return obj


def request(current, previous=None, key=None, budget=0, **kwargs):
    return VerificationCreate(current_id=current.id, previous_id=previous.id if previous else None, bundle_hash=bundle(current, previous), idempotency_key=key or str(uuid4()), budget_usd=budget, **kwargs)


def verification(db, *, budget=0, daily=0):
    current = decision(db)
    v = create_verification(db, 1, request(current, budget=budget), daily_cap=daily); db.commit(); return v


def test_synthetic_arithmetic_and_rounding_are_distinct():
    samples = [sample(), sample((-2,0,-1,2,-1,1), job=2)]
    result = calculate(samples, formula(), {"confidence":"7.0", "bias":"bearish", "premarket":"0", "last5":"0"})
    assert result["numerator"] == "-24.0"
    assert result["score"] == "-1.2"
    assert result["rationale_mean"] == "0.0"
    assert result["formula_action"] == "Trim" and result["formula_units"] == "-0.5"
    sized = sizing_layer(result, "india")
    assert sized["action"] == "Trim" and sized["units"] is None
    assert sized["review_required"] is True
    assert sized["findings"][0]["code"] == "whole_share_choice_required"
    assert calculate(samples, formula())["formula_action"] == "Hold"
    assert any(f["code"] == "same_model_consensus" for f in result["findings"])


@pytest.mark.parametrize("score,current,action", [("-2.0001",1,"Sell All"),("-2",1,"Trim"),("-1.0001",1,"Trim"),("-1",1,"Hold"),("0.9999",0,"Hold"),("1",0,"Buy New"),("1",1,"Add more")])
def test_threshold_boundaries(score,current,action): assert action_for_score(Decimal(score), Decimal(current)) == action


@pytest.mark.parametrize("corrupt", [lambda s:s["row"].pop(SCORE_FIELDS[0]),lambda s:s["row"].update(current_units=None),lambda s:s["row"].update(final_units=1),lambda s:s.update(valid=False),lambda s:s["row"].update(units_change=float("nan"))])
def test_missing_and_invalid_inputs_never_become_hold(corrupt):
    s=sample();corrupt(s);result=calculate([s],formula());assert result["formula_action"] is None


def test_legacy_formula_is_unknown():
    r=calculate([sample()],None); assert r["score"] is None and r["formula_action"] is None


def test_cross_exchange_requires_canonical_mapping():
    previous={"market":"india","symbol":"FIXTUREEQ","exchange":"BSE","calculation":{}}
    current={**previous,"exchange":"NSE"}
    assert compare(previous,current)["comparable"] is False
    previous["isin"]=current["isin"]="canonical";assert compare(previous,current)["comparable"] is True


def test_tenant_scope_and_idempotency(db):
    current=decision(db);other=decision(db,user=2)
    assert owned_decision(db,2,current.id) is None
    with pytest.raises(LookupError): create_verification(db,1,request(other),daily_cap=0)
    body=request(current,key="stable-key"); first=create_verification(db,1,body,daily_cap=0);db.commit()
    assert create_verification(db,1,body,daily_cap=0).id == first.id
    assert create_verification(db,1,request(current),daily_cap=0).id == first.id
    with pytest.raises(AuditConflict): create_verification(db,1,body.model_copy(update={"budget_usd":Decimal(1)}),daily_cap=1)
    with pytest.raises(AuditConflict): create_verification(db,1,body.model_copy(update={"bundle_hash":"0"*64}),daily_cap=0)


def test_append_only_orm(db):
    current=decision(db);current.payload={"rewritten":True}
    with pytest.raises(ValueError,match="append-only"): db.commit()
    db.rollback();db.delete(current)
    with pytest.raises(ValueError,match="append-only"): db.commit()
    db.rollback()


def test_lease_duplicate_and_stale_completion(db):
    v=verification(db);first=claim_lease(db,v.id);fence=first.fence
    assert claim_lease(db,v.id) is None
    v.lease_until=datetime.now(timezone.utc)-timedelta(seconds=1);db.commit()
    second=claim_lease(db,v.id);assert second.fence==fence+1
    assert not finish(db,v.id,fence,result={"verdict":"supported"})
    assert finish(db,v.id,second.fence,result={"verdict":"insufficient_evidence"})
    assert not finish(db,v.id,second.fence,result={"verdict":"supported"})


def test_budget_reservation_prevents_repeat_and_daily_overspend(db):
    v=verification(db,budget=Decimal("0.3"),daily=Decimal("0.2"));lease=claim_lease(db,v.id)
    a=reserve(db,v.id,lease.fence,attempt_key="first",adapter="test",tariff_version="fixed",upper_bound="0.15",daily_cap="0.2")
    assert v.reserved_usd == Decimal("0.15")
    with pytest.raises(BudgetBlocked): reserve(db,v.id,lease.fence,attempt_key="second",adapter="test",tariff_version="fixed",upper_bound="0.1",daily_cap="0.2")
    with pytest.raises(BudgetBlocked): reserve(db,v.id,lease.fence,attempt_key="first",adapter="test",tariff_version="fixed",upper_bound="0",daily_cap="0.2")
    settle(db,a,None);assert v.reserved_usd == Decimal("0.15")
    settle(db,a,"0.12");assert v.spent_usd==Decimal("0.12") and v.reserved_usd==0
    settle(db,a,"0.12");assert v.spent_usd==Decimal("0.12")


def test_unknown_tariff_zero_budget_and_cancelled_lease_block(db):
    v=verification(db);lease=claim_lease(db,v.id)
    with pytest.raises(BudgetBlocked): reserve(db,v.id,lease.fence,attempt_key="x",adapter="test",tariff_version="",upper_bound=None,daily_cap=0)
    with pytest.raises(BudgetBlocked): reserve(db,v.id,lease.fence,attempt_key="x",adapter="test",tariff_version="fixed",upper_bound="0.01",daily_cap=0)
    v.status="cancelled";v.fence+=1;db.commit()
    with pytest.raises(BudgetBlocked): reserve(db,v.id,lease.fence-1,attempt_key="x",adapter="test",tariff_version="fixed",upper_bound=0,daily_cap=0)


def test_sub_precision_price_cannot_round_away_budget(db):
    v=verification(db,budget=Decimal("0.01"),daily=Decimal("0.01"));lease=claim_lease(db,v.id)
    attempt=reserve(db,v.id,lease.fence,attempt_key="tiny",adapter="fixture",tariff_version="fixed",upper_bound="0.0000000001",daily_cap="0.01")
    assert v.reserved_usd==Decimal("0.00000001")
    settle(db,attempt,"0.0000000001");assert v.spent_usd==Decimal("0.00000001")


def test_posthoc_and_unavailable_publication_never_support():
    claim=Claim(id="trigger",kind="close_below",text="close below 80",threshold=80)
    decision_data={"original_completion_at":NOW.isoformat(),"calculation":{"findings":[]},"coverage":{"successful":2,"attempted":2}}
    base=dict(id="1",claim_id="trigger",source_id="official",source_url="https://example.test",content_hash="a"*64,observed_at=NOW,independent=True,stance="supports",countersearch_complete=True,detail="price")
    assert evaluate(decision_data,{"comparable":True},[claim],[Observation(**base)]) ["verdict"]=="insufficient_evidence"
    assert evaluate(decision_data,{"comparable":True},[claim],[Observation(**base,available_at=NOW+timedelta(seconds=1))])["verdict"]=="insufficient_evidence"
    assert evaluate(decision_data,{"comparable":True},[claim],[Observation(**base,available_at=NOW)])["verdict"]=="supported"
    base["stance"]="contradicts";assert evaluate(decision_data,{"comparable":True},[claim],[Observation(**base,available_at=NOW)])["verdict"]=="unsupported"


def test_candles_require_completion_and_seek_invalidation():
    claims=[Claim(id="trigger",kind="close_below",text="close below 80",threshold=80),Claim(id="invalidation",kind="close_above",text="close above 120",threshold=120)]
    candles=[{"close":75,"completed_at":(NOW+timedelta(hours=1)).isoformat(),"available_at":NOW.isoformat(),"complete":False}]
    kwargs=dict(decision_at=NOW,source_id="price",source_url="https://example.test",content_hash="a"*64,observed_at=NOW)
    assert candle_observations(claims,candles,**kwargs)==[]
    candles=[{"close":125,"completed_at":NOW.isoformat(),"available_at":NOW.isoformat(),"complete":True}]
    obs=candle_observations(claims,candles,**kwargs);assert all(o.stance=="contradicts" for o in obs)


def test_stored_worker_does_not_use_external_collector(db):
    v=verification(db)
    def prohibited(*args): raise AssertionError("External call")
    assert run_verification(db,v.id,SimpleNamespace(recommendation_audit_external_enabled=False),external_collector=prohibited)
    assert v.verdict=="insufficient_evidence"


def test_technical_header_adapter_preserves_ambiguity():
    text="| Exchange Symbol | Stock Symbol | Bias | Confidence Score | Premarket trend | Last 5 candles trend | Trigger Level | Invalidation Level |\n|---|---|---|---|---|---|---|---|\n| NSE | FIXTUREEQ | Bearish | 7.0 | 0 | -2 | close below 80 | close above 120 |\n"
    rows=technical_rows(text);assert rows[("FIXTUREEQ","NSE")]["confidence"]=="7.0"
    assert technical_rows(text+text)[("FIXTUREEQ","NSE")] is None


def test_sensitivity_removes_same_model_family_without_faking_neutral():
    r=sensitivity({"formula":formula().model_dump(mode="json"),"samples":[sample(),sample(job=2)]})
    leave=[s for s in r["scenarios"] if s["parameter"]=="leave_one_provider_model_out"][0]
    assert leave["action"] is None


def test_walk_forward_requires_identity_and_real_available_prices():
    assert walk_forward([{"decision_at":NOW.isoformat()}],[])["status"]=="insufficient_evidence"
    record={"id":"r","market":"india","security_id":"verified-test","coverage":{"successful":1,"attempted":1,"captured_terminal":1},"decision_at":NOW.isoformat(),"original_completion_at":NOW.isoformat(),"inputs_available_at":NOW.isoformat(),"formula":formula().model_dump(mode="json"),"samples":[sample((2,3,2,3,1,2),current=0,action="Buy New",change=1,final=1)]}
    prices=[{"market":"india","security_id":"verified-test","at":(NOW+timedelta(days=i)).isoformat(),"available_at":(NOW+timedelta(days=i)).isoformat(),"price":100+i,"adjusted":True,"tradable":True} for i in range(3)]
    result=walk_forward([record],prices,train_fraction=Decimal(0))
    assert result["trades"][0]["fill_at"]==prices[1]["at"]
    assert Decimal(result["trades"][0]["fee"])>0
    prices[1]["available_at"]=(NOW+timedelta(days=4)).isoformat()
    result=walk_forward([record],prices,train_fraction=Decimal(0));assert result["excluded_prices"]==1
    record["coverage"].pop("captured_terminal")
    assert walk_forward([record],prices,train_fraction=Decimal(0))["eligible_decisions"]==0


def test_expired_lease_blocks_spend_admission(db):
    v=verification(db,budget="0.1",daily="0.1");lease=claim_lease(db,v.id)
    v.lease_until=datetime.now(timezone.utc)-timedelta(seconds=1);db.commit()
    with pytest.raises(BudgetBlocked,match="expired"):
        reserve(db,v.id,lease.fence,attempt_key="expired",adapter="fixture",tariff_version="v1",upper_bound="0.01",daily_cap="0.1")
    assert not list(db.scalars(select(SpendAttempt)))


def test_incomplete_past_candle_never_contradicts_and_unknown_availability_is_visible():
    claim=Claim(id="trigger",kind="close_below",text="close below 80",threshold=80)
    kwargs=dict(decision_at=NOW,source_id="price",source_url="https://example.test",content_hash="a"*64,observed_at=NOW)
    candle={"close":125,"completed_at":NOW.isoformat(),"available_at":NOW.isoformat(),"complete":False}
    assert candle_observations([claim],[candle],**kwargs)==[]
    candle.update(complete=True,available_at=None)
    obs=candle_observations([claim],[candle],**kwargs)
    assert len(obs)==1 and obs[0].available_at is None and obs[0].stance=="contradicts"
    assert evaluate({"original_completion_at":NOW.isoformat(),"coverage":{"successful":1,"attempted":1}}, {"comparable":True},[claim],obs)["verdict"]=="insufficient_evidence"


def test_replay_and_sensitivity_preserve_capture_failure():
    from app.domains.recommendation_audit.evaluation import replay
    record={"formula":formula().model_dump(mode="json"),"samples":[sample((2,3,2,3,1,2),current=0,action="Buy New",change=1,final=1)],"calculation":{"formula_action":None,"findings":[{"code":"stock_coverage_incomplete","severity":"error","detail":"failed sibling"}]},"coverage":{"successful":1,"attempted":2}}
    assert replay([record])[0]["calculation"]["formula_action"] is None
    assert all(s["action"] is None for s in sensitivity(record)["scenarios"])


def test_technical_agreement_ignores_transport_hash_and_retains_sources():
    from app.domains.recommendation_audit.technical import agreed_technical
    text="| Exchange Symbol | Stock Symbol | Bias | Confidence Score | Premarket trend | Last 5 candles trend | Trigger Level | Invalidation Level |\n|---|---|---|---|---|---|---|---|\n| NSE | FIXTUREEQ | Bearish | 7.0 | 0 | -2 | close below 80 | close above 120 |\n"
    outputs=[SimpleNamespace(id="a",content=text,payload={"status":"completed"}),SimpleNamespace(id="b",content="Different surrounding text\n\n"+text,payload={"status":"completed"})]
    row=agreed_technical(outputs)[("FIXTUREEQ","NSE")]
    assert len(set(row["source_hashes"]))==2 and row["output_ids"]==["a","b"]
    outputs[1].payload["status"]="failed";assert agreed_technical(outputs)=={}


def test_approved_setup_direction_uses_captured_registry_and_unknown_fallback_fails():
    from app.domains.recommendation_audit.technical import agreed_technical
    prompt="### Bearish / Sell-Trim Setups\n| Setup | Bias | Confidence | Best use | Trigger | Invalidation |\n|---|---|---|---|---|---|\n| Lower-high pullback | Bearish | 7.0/10 | exit | below | above |\n"
    text="| Exchange Symbol | Stock Symbol | Primary Setup | Bias | Confidence Score | Premarket trend | Last 5 candles trend | Trigger Level | Invalidation Level |\n|---|---|---|---|---|---|---|---|---|\n| NSE | FIXTUREEQ | Lower-high pullback | Bullish | 7.0 | 0 | 0 | close below 80 | close above 120 |\n"
    output=SimpleNamespace(id="a",content=text,payload={"status":"completed"})
    row=agreed_technical([output],prompt)[("FIXTUREEQ","NSE")]
    assert row["bias"]=="bearish" and row["declared_bias"]=="bullish"
    unknown=agreed_technical([output],"")[("FIXTUREEQ","NSE")]
    assert calculate([sample()],formula(),unknown)["formula_action"] is None
    output.content=text.replace("Lower-high pullback","")
    missing=agreed_technical([output],prompt)[("FIXTUREEQ","NSE")]
    assert "missing or blank" in missing["policy_error"]
    assert calculate([sample()],formula(),missing)["formula_action"] is None
