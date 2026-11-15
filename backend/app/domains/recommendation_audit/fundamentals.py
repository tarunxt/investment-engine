"""Bounded official XBRL evidence, preserving periods/units/identity uncertainty.

This is a filing reader, not a taxonomy validator or investment thesis model.
Only URLs already present in frozen evidence may be fetched by the worker.
"""
from datetime import date
from decimal import Decimal,localcontext
import io
import re
from urllib.parse import urlsplit,unquote
from xml.etree import ElementTree as ET
from pydantic import Field

from .schemas import StrictModel
from .deterministic import digest,number

XBRLI="http://www.xbrl.org/2003/instance"
XBRLDI="http://xbrl.org/2006/xbrldi"
MAX_FACTS=200


class FilingFact(StrictModel):
    concept: str = Field(max_length=512)
    context_id: str = Field(max_length=128)
    entity_identifier: str | None = Field(default=None,max_length=256)
    entity_scheme: str | None = Field(default=None,max_length=256)
    period_start: date | None = None
    period_end: date | None = None
    instant: date | None = None
    dimensions: dict[str,str] = Field(default_factory=dict,max_length=20)
    unit_measures: list[str] = Field(default_factory=list,max_length=8)
    value: Decimal | None = None
    raw_value: str = Field(max_length=100)
    scale: int = Field(default=0,ge=-12,le=12)
    decimals: str | None = Field(default=None,max_length=32)


def official_filing_url(url):
    try: parsed=urlsplit(url)
    except ValueError: return False
    path=unquote(parsed.path)
    try: port=parsed.port
    except ValueError: return False
    return bool(parsed.scheme=="https" and parsed.hostname=="nsearchives.nseindia.com" and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and port in {None,443} and path.startswith("/corporate/") and re.fullmatch(r"/[A-Za-z0-9_./-]+\.xml",path,re.I) and all(segment not in {".",".."} for segment in path.split("/")))


def parse_filing(content, *, source_url, observed_at):
    if not official_filing_url(source_url): raise ValueError("Unrecognized official filing URL")
    if len(content.encode())>262144: raise ValueError("Filing byte bound exceeded")
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b",content,re.I): raise ValueError("XML declarations/entities are blocked")
    namespaces={}
    for _,(prefix,uri) in ET.iterparse(io.StringIO(content),events=("start-ns",)):
        if prefix in namespaces and namespaces[prefix]!=uri: raise ValueError("Rebound XML namespace is ambiguous")
        namespaces[prefix]=uri
    root=ET.fromstring(content)
    if root.tag!=f"{{{XBRLI}}}xbrl": raise ValueError("Expected an XBRL instance document")
    if sum(1 for _ in root.iter())>12000: raise ValueError("XBRL node bound exceeded")
    def expanded(value):
        if ":" not in value: return value
        prefix,local=value.split(":",1)
        if prefix not in namespaces: raise ValueError("Undefined QName namespace")
        return f"{{{namespaces[prefix]}}}{local}"
    contexts,units,findings={},{},[]
    for context in root.findall(f"{{{XBRLI}}}context"):
        identifier=context.get("id")
        if not identifier or identifier in contexts or len(contexts)>=512: raise ValueError("Missing/duplicate/excess context IDs")
        entity=context.find(f"{{{XBRLI}}}entity/{{{XBRLI}}}identifier")
        period=context.find(f"{{{XBRLI}}}period")
        def dated(key):
            item=period.find(f"{{{XBRLI}}}{key}") if period is not None else None
            return date.fromisoformat(item.text.strip()) if item is not None and item.text else None
        dimensions={}
        for member in context.iter(f"{{{XBRLDI}}}explicitMember"):
            key=expanded(member.get("dimension", ""))
            if not key or key in dimensions: raise ValueError("Duplicate/missing context dimension")
            dimensions[key]=expanded((member.text or "").strip())
        if any(True for _ in context.iter(f"{{{XBRLDI}}}typedMember")): findings.append("Typed dimensions retained only in original XML; context interpretation incomplete")
        contexts[identifier]={"entity_identifier":entity.text.strip() if entity is not None and entity.text else None,"entity_scheme":entity.get("scheme") if entity is not None else None,"period_start":dated("startDate"),"period_end":dated("endDate"),"instant":dated("instant"),"dimensions":dimensions}
    for unit in root.findall(f"{{{XBRLI}}}unit"):
        identifier=unit.get("id")
        if not identifier or identifier in units: raise ValueError("Missing/duplicate unit IDs")
        if unit.find(f"{{{XBRLI}}}divide") is not None:
            units[identifier]=[];findings.append("Ratio/divided units are not normalized")
        else: units[identifier]=[expanded((measure.text or "").strip()) for measure in unit.findall(f"{{{XBRLI}}}measure")]
    facts,seen=[],{}
    for element in root.iter():
        context_id=element.get("contextRef")
        if not context_id or element.get("unitRef") is None: continue
        if context_id not in contexts or element.get("unitRef") not in units: raise ValueError("Unknown fact context/unit reference")
        raw=(element.text or "").strip()
        if len(raw)>100: raise ValueError("Numeric fact text bound exceeded")
        nil=element.get("{http://www.w3.org/2001/XMLSchema-instance}nil") in {"true","1"}
        value=None if nil else number(raw)
        if value is None and not nil: findings.append("Unparseable numeric fact; no zero substitution")
        scale=int(element.get("scale","0"))
        if not -12<=scale<=12: raise ValueError("Fact scale bound exceeded")
        with localcontext() as precision:
            precision.prec=120
            scaled=value*Decimal(10)**scale if value is not None else None
        fact=FilingFact(concept=element.tag,context_id=context_id,**contexts[context_id],unit_measures=units[element.get("unitRef")],value=scaled,raw_value=raw,scale=scale,decimals=element.get("decimals"))
        key=(fact.concept,context_id,tuple(fact.unit_measures))
        if key in seen and seen[key]!=fact.value: findings.append("Conflicting duplicate facts; no preferred value selected")
        seen[key]=fact.value
        if len(facts)<MAX_FACTS: facts.append(fact.model_dump(mode="json"))
        else: findings.append("Fact display bound reached; full original XML retained")
    if not facts: findings.append("No supported numeric facts found")
    return {"source_id":"nse-xbrl-filing-v1","source_url":source_url,"content_hash":digest(content),"observed_at":observed_at.isoformat(),"published_at":None,"available_at":None,"facts":facts,"context_count":len(contexts),"findings":sorted(set(findings)),"identity_status":"unverified","taxonomy_validation_complete":False,"limitations":["Filing entity identifiers are preserved; canonical stock mapping is not certified","Original exchange publication/availability timestamp is not supplied by this document transport","Concept tags, periods, units and dimensions are preserved without inferred revenue/profit semantics","No taxonomy validation, restatement/corporate-action reconciliation, or qualitative thesis certification"]}


def read_fundamentals_filing(url, *, transport=None):
    from .adapters import get_bytes
    text,observed=get_bytes(url,transport=transport)
    result=parse_filing(text,source_url=url,observed_at=observed)
    return {**result,"content":text}
