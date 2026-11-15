from datetime import datetime,timezone
from types import SimpleNamespace
import pytest

from app.domains.recommendation_audit.fundamentals import parse_filing,read_fundamentals_filing,official_filing_url
from app.domains.recommendation_audit.worker import collect_external,claim_lease
from app.domains.recommendation_audit.capture import add_evidence
from app.domains.recommendation_audit.models import DecisionRecord,EvidenceRecord,SpendAttempt
from sqlalchemy import select
from test_recommendation_audit import db,verification,decision
from test_recommendation_audit_adapters import Response

URL="https://nsearchives.nseindia.com/corporate/fixture.xml"
NOW=datetime(2026,10,7,tzinfo=timezone.utc)
XML='''<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:fixture="https://fixture.invalid.test/taxonomy" xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
<xbrli:context id="quarter"><xbrli:entity><xbrli:identifier scheme="fixture-cin">UNVERIFIED-ENTITY</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="fixture:ScopeAxis">fixture:ConsolidatedMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2026-04-01</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:unit id="inr"><xbrli:measure>iso4217:INR</xbrli:measure></xbrli:unit>
<fixture:RevenueFromOperations contextRef="quarter" unitRef="inr" decimals="2" scale="6">123.456</fixture:RevenueFromOperations>
</xbrli:xbrl>'''


def test_reader_preserves_period_units_scope_and_does_not_invent_certification():
    calls=[]
    def transport(url,**kwargs):
        calls.append((url,kwargs));return Response(XML)
    source=read_fundamentals_filing(URL,transport=transport)
    assert len(calls)==1 and calls[0][1]["timeout"]==(3,10) and not calls[0][1]["allow_redirects"]
    fact=source["facts"][0]
    assert fact["value"]=="123456000.000" and fact["period_start"]=="2026-04-01" and fact["period_end"]=="2026-06-30"
    assert fact["unit_measures"]==["{http://www.xbrl.org/2003/iso4217}INR"]
    assert len(fact["dimensions"])==1 and fact["entity_identifier"]=="UNVERIFIED-ENTITY"
    assert source["identity_status"]=="unverified" and source["taxonomy_validation_complete"] is False
    assert source["available_at"] is None and "verdict" not in source and source["content"]==XML


@pytest.mark.parametrize("url",["https://evil.example/corporate/a.xml","https://nsearchives.nseindia.com/corporate/../private.xml","https://nsearchives.nseindia.com/corporate/%2e%2e/a.xml","https://nsearchives.nseindia.com/corporate/a.xml?redirect=x","https://nsearchives.nseindia.com/corporate/a.pdf","https://user:pass@nsearchives.nseindia.com/corporate/a.xml"])
def test_filing_url_rejects_unrequested_sources(url):
    assert not official_filing_url(url)
    with pytest.raises(ValueError): read_fundamentals_filing(url,transport=lambda *a,**k:pytest.fail("Network"))


@pytest.mark.parametrize("xml",['<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]>'+XML,XML.replace('contextRef="quarter"','contextRef="unknown"'),XML.replace('unitRef="inr"','unitRef="unknown"'),XML.replace('scale="6"','scale="99"')])
def test_malformed_or_unsafe_documents_are_rejected(xml):
    with pytest.raises(ValueError): parse_filing(xml,source_url=URL,observed_at=NOW)


def test_conflicting_duplicates_and_truncation_remain_visible():
    extra='<fixture:RevenueFromOperations contextRef="quarter" unitRef="inr">999</fixture:RevenueFromOperations>'
    source=parse_filing(XML.replace('</xbrli:xbrl>',extra+'</xbrli:xbrl>'),source_url=URL,observed_at=NOW)
    assert len(source["facts"])==2 and any("Conflicting duplicate" in f for f in source["findings"])
    source=parse_filing(XML.replace('</xbrli:xbrl>',extra*210+'</xbrli:xbrl>'),source_url=URL,observed_at=NOW)
    assert len(source["facts"])==200 and any("bound reached" in f for f in source["findings"])


def test_unknown_values_do_not_become_zero_and_precision_is_preserved():
    source=parse_filing(XML.replace('123.456','unknown'),source_url=URL,observed_at=NOW)
    assert source["facts"][0]["value"] is None
    large='1234567890123456789012345678901234567890'
    source=parse_filing(XML.replace('123.456',large),source_url=URL,observed_at=NOW)
    assert source["facts"][0]["value"]==large+'000000'


def test_worker_fetches_only_captured_filing_and_preserves_immutable_evidence(db,monkeypatch):
    monkeypatch.setenv("CREDX_RECOVERY_MODE","0")
    v=verification(db);lease=claim_lease(db,v.id)
    current=db.get(DecisionRecord,v.current_id)
    inp=add_evidence(db,user_id=1,kind="input",source_key="filing-fixture",run_id=10,payload={},content=URL)
    db.commit()
    # Immutable decision fixture is wrapped rather than mutated.
    wrapper=SimpleNamespace(market="india",run_id=10,payload={**current.payload,"input_id":inp.id})
    calls=[]
    monkeypatch.setattr("requests.get",lambda url,**kwargs:(calls.append(url) or Response(XML)))
    settings=SimpleNamespace(recommendation_audit_kite_incremental_cost_usd=None,recommendation_audit_fundamentals_enabled=True,recommendation_audit_daily_cap_usd=0)
    observations,sources,limitations=collect_external(db,v,lease.fence,wrapper,[],settings);db.commit()
    assert calls==[URL] and not observations and sources[0]["facts"]
    evidence=db.scalar(select(EvidenceRecord).where(EvidenceRecord.kind=="external"))
    assert evidence.content==XML and evidence.payload["identity_status"]=="unverified"
    assert len(list(db.scalars(select(SpendAttempt))))==1 and v.spent_usd==0


def test_worker_no_captured_url_makes_no_fundamentals_request(db,monkeypatch):
    monkeypatch.setenv("CREDX_RECOVERY_MODE","0")
    v=verification(db);lease=claim_lease(db,v.id)
    current=SimpleNamespace(market="india",run_id=10,payload={"input_id":None})
    monkeypatch.setattr("requests.get",lambda *a,**k:pytest.fail("Unexpected API"))
    settings=SimpleNamespace(recommendation_audit_kite_incremental_cost_usd=None,recommendation_audit_fundamentals_enabled=True,recommendation_audit_daily_cap_usd=0)
    _,sources,limitations=collect_external(db,v,lease.fence,current,[],settings)
    assert not sources and any("No exact official" in l for l in limitations)
