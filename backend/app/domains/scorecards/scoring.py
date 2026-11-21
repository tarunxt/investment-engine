"""Publish one row per listing from the actual queued jobs; null denotes missing evidence."""
from collections import Counter, defaultdict
from datetime import datetime
import re
from urllib.parse import urlparse
import json
import math
from statistics import mean

from app.domains.jobs.output_contracts.document import parse_markdown
from app.domains.runs.final_score_math import ACTIONS, ACTION_VALUES, ACTION_HEADER, RATIONALE_HEADERS, normalize_action
from app.domains.runs.threat_evidence import audited_evidence, stock_scorecards
from .prompts import CATEGORIES, CATALOGUE, HEADERS

R_WEIGHTS = dict(zip([*RATIONALE_HEADERS, "action"], [3,3,2,1,3,1,4]))
ACTION_SCORES = {"Sell All": -2.5, "Trim": -1.5, "Hold": 0, "Buy New": 1.5, "Add more": 2.5}
T_WEIGHTS = {"candles": 5, "premarket": 0, "setup": 0}


def number(value, low, high, *, integer=False):
    if value is None or isinstance(value, bool):
        return None
    try:
        n = float(value)
    except (ValueError, TypeError):
        return None
    return n if math.isfinite(n) and low <= n <= high and (not integer or n.is_integer()) else None


def average(values):
    known = [n for n in values if n is not None]
    return mean(known) if known else None


def weighted(terms, weights):
    available = [(terms[k], w) for k,w in weights.items() if w > 0 and terms.get(k) is not None]
    divisor = sum(w for _,w in available)
    return (sum(x*w for x,w in available)/divisor if divisor else None), divisor


def favorable(value):
    return None if value is None else (value + 3) * 100 / 6


def parse_rows(response, card, assigned):
    blocks, findings = parse_markdown(response or "")
    identity_headers = {"Exchange Symbol", "Stock Symbol"}
    tables = [block for block in blocks if block.kind == "table" and identity_headers.intersection(block.headers)]
    if len(tables) != 1 or any(f.severity == "error" for f in findings):
        return {}, "Response requires one well-formed table"
    table = tables[0]
    if len(set(table.headers)) != len(table.headers) or not {"Exchange Symbol","Stock Symbol"} <= set(table.headers):
        return {}, "Missing or duplicate identity columns"
    if tuple(table.headers) != HEADERS[card]:
        return {}, f"{card.title()} headers differ from the scorecard contract"
    rows = {}
    for cells in table.rows:
        if len(cells) != len(table.headers):
            continue
        r = dict(zip(table.headers, cells))
        exchange, symbol = r["Exchange Symbol"], r["Stock Symbol"]
        if ":" in exchange:
            venue, ticker = exchange.split(":", 1)
            if exchange not in assigned or ticker != symbol:
                continue
            exchange = venue
            r["Exchange Symbol"] = venue
        key = exchange + ":" + symbol
        if key in assigned:
            rows[key] = None if key in rows else r
    return {k:r for k,r in rows.items() if r}, None


def rebalance(rowset, stock, cutoff):
    observations = []
    for r in rowset:
        if not dated_reference(r.get("Analyst/Source"), cutoff):
            continue
        action = normalize_action(r.get(ACTION_HEADER))
        units, change, final = [number(r.get(k), -1e15, 1e15) for k in ("Current Units","Units Change","Final Units")]
        if action is None or units is None or units != stock["units"] or change is None or final is None or final < 0 or not math.isclose(units+change,final,abs_tol=1e-8):
            continue
        if (action == "Hold" and change != 0 or action == "Sell All" and final != 0 or action == "Trim" and change >= 0
                or action in ("Buy New","Add more") and change <= 0 or action == "Buy New" and units != 0
                or stock["origin"] == "contender" and action not in ("Hold","Buy New")):
            continue
        observations.append(r)
    terms = {k: average(number(r.get(header),-3,3,integer=True) for r in observations if str(r.get(header.replace("Score Rationale","Rationale"),"")).strip() not in ("","-","—")) for k,header in RATIONALE_HEADERS.items()}
    actions = [normalize_action(r[ACTION_HEADER]) for r in observations if str(r.get("Rationale Cruxx","")).strip() not in ("","-","—")]
    mode = None
    if actions:
        counts = Counter(actions)
        center = mean(ACTION_VALUES[a] for a in actions)
        mode = min(counts,key=lambda a:(-counts[a],abs(ACTION_VALUES[a]-center),ACTIONS.index(a)))
    terms["action"] = ACTION_SCORES.get(mode)
    result, divisor = weighted(terms,R_WEIGHTS)
    return {"score":favorable(result),"terms":{k:favorable(v) for k,v in terms.items()},"signed_terms":terms,
            "action":mode,"raw_rows":observations,"available_weight":divisor,"model_count":len(observations),"coverage": "Complete" if divisor == sum(R_WEIGHTS.values()) else "Partial"}


def dated_reference(text, cutoff):
    if not isinstance(text, str):
        return False
    url_pattern = r"https?://[^\s\])>]+"
    urls = re.findall(url_pattern, text)
    observation = re.sub(url_pattern, " ", text)
    stamp_pattern = r"\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+−-]\d{2}:\d{2}))?(?![\w:+-])"
    stamps = re.findall(stamp_pattern, observation)
    if not urls or not stamps:
        return False
    try:
        if not all(urlparse(url).hostname for url in urls):
            return False
        boundary = datetime.fromisoformat(cutoff)
        for stamp in stamps:
            moment = datetime.fromisoformat(stamp.replace("−", "-"))
            if moment.tzinfo is None:
                if moment.date() >= boundary.date():
                    return False
            elif moment > boundary:
                return False
        return True
    except (ValueError, TypeError):
        return False


def approved_setup(row):
    label = str(row.get("Primary Setup") or "").strip()
    if label in CATALOGUE:
        return CATALOGUE[label]
    annotated = re.fullmatch(r"(.+?)\s*\((\d+(?:\.\d+)?)\)", label)
    if annotated:
        setup = CATALOGUE.get(annotated[1].rstrip())
        if setup and number(annotated[2], 0, 10) == setup["confidence"]:
            return setup
    return None


def technical(rowset, cutoff):
    def verified(row):
        return dated_reference(str(row.get("Evidence source and as-of","")), cutoff)
    rows = [r for r in rowset if verified(r)]
    candidates = [(r, approved_setup(r)) for r in rows]
    strengths = [3*s["confidence"]/10*(1 if s["direction"]=="bullish" else -1) for r,s in candidates
                 if s and number(r.get("Confidence Score"),0,10)==s["confidence"] and r.get("Bias","").casefold()==s["direction"]]
    terms = {"candles":average(number(r.get("Last 5 candles trend"),-3,3,integer=True) for r in rows),
             "premarket":average(number(r.get("Premarket trend"),-3,3,integer=True) for r in rows),
             "setup":average(strengths)}
    return {"score":favorable(terms["candles"]),"terms":{k:favorable(v) for k,v in terms.items()},
            "signed_terms":terms,"raw_rows":rowset,"coverage":"Complete" if terms["candles"] is not None else "Unassessed"}


def json_items(raw):
    try:
        data = json.loads(raw or "[]")
    except (ValueError, TypeError):
        return []
    return [r for r in data if isinstance(r,dict)] if isinstance(data,list) else []


def normalize_threat_publication(entry, cutoff):
    reported = entry["As of"].strip()
    annotated = re.fullmatch(r"(\S+)(?: session close)?;\s*observed(?: at)?\s+(\S+)", reported, re.IGNORECASE)
    try:
        published = datetime.fromisoformat(annotated[1] if annotated else reported)
        observed = datetime.fromisoformat(annotated[2]) if annotated else published
        if (cutoff.tzinfo is not None and published.tzinfo is not None and observed.tzinfo is not None
                and published <= observed <= cutoff):
            entry["Publication timestamp"] = reported
            entry["As of"] = published.astimezone(cutoff.tzinfo).date().isoformat()
    except ValueError:
        pass  # The common evidence audit records the exclusion.


def threats_by_slot(slot_rows, cutoff):
    fields = {"Category":"category","Scenario":"scenario_id","Trigger":"trigger","Likelihood":"likelihood","Impact":"impact",
              "Downside":"downside","Source":"source_url","As of":"published_at","Confidence":"confidence","Rationale":"rationale"}
    boundary = datetime.fromisoformat(cutoff)
    evidence = []
    for listing, row in slot_rows.items():
        exchange,symbol = listing.split(":",1)
        for item in json_items(row.get("Evidence")):
            entry = {"Exchange":exchange,"Symbol":symbol,**{k:str(item.get(v,"")) for k,v in fields.items()}}
            category = re.fullmatch(r"C([1-8])", entry["Category"].strip(), re.IGNORECASE)
            if category:
                entry["Category"] = category[1]
            # The common auditor consumes dates. A timestamp must first pass
            # the exact decision cutoff, including its original time zone.
            normalize_threat_publication(entry, boundary)
            if entry["Confidence"].strip().casefold() == "moderate":
                entry["Confidence"] = "medium"
            evidence.append(entry)
    accepted, dispositions = audited_evidence(evidence, strict=True,snapshot_date=boundary.date())
    return {":".join(k):v for k,v in stock_scorecards(accepted).items()}, dispositions


def threats(listing, slots, raw):
    cards = [table[listing] for table,_ in slots if listing in table]
    risk = average(c["score"] for c in cards)
    categories = {label:average(c["categories"][i]["score"] for c in cards) for i,label in enumerate(CATEGORIES,1)}
    trails = [{**r,"slot":slot} for slot,(_, records) in enumerate(slots,1) for r in records if r["Exchange"]+":"+r["Symbol"]==listing]
    return {"score":None if risk is None else 100-risk, "stock_threat":risk, "categories":categories,
            "terms":{k:None if v is None else 100-v for k,v in categories.items()}, "assessed":sum(v is not None for v in categories.values()),
            "extreme":any(r.get("Impact")=="5" and r["Disposition"]=="Accepted" for r in trails),
            "coverage":"Complete" if cards and all(not c["provisional"] for c in cards) else "Partial",
            "evidence":trails,"raw_rows":raw}


def pair_results(votes, keys):
    by_stock = defaultdict(list)
    for (left,right), per_slot in votes.items():
        counts = Counter(v["result"] for v in per_slot.values() if v and v["result"] != "UNKNOWN")
        verdict = "UNKNOWN"
        if counts:
            top,n = counts.most_common(1)[0]
            if 2*n > sum(counts.values()):
                verdict = top
        for key, other in ((left,right),(right,left)):
            by_stock[key].append({"opponent":other,"verdict":verdict,"evidence":[v for v in per_slot.values() if v]})
    results = {}
    for key in keys:
        history = by_stock[key]
        wins = sum(r["verdict"]==key for r in history)
        ties = sum(r["verdict"]=="TIE" for r in history)
        valid = sum(r["verdict"]!="UNKNOWN" for r in history)
        expected = len(keys)-1
        score = None if not valid else 100*(wins+ties/2)/valid
        results[key] = {"score":score,"terms":{"pairwise":score},"wins":wins,"ties":ties,"losses":valid-wins-ties,
                        "valid":valid,"expected":expected,"coverage_pct":100*valid/expected if expected else None,
                        "coverage":"Complete" if valid and valid==expected else "Partial","comparisons":history}
    return results


def supported_row(row, card, key, research, job):
    if research is None:
        return row
    records = research.get("listings",{}).get(key,[])
    provider_sources = set(getattr(job,"web_sources",None) or [])
    observed = {r["url"] for r in records if r["kind"]!="filing_index"} | provider_sources
    def cited(text, urls):
        return isinstance(text,str) and any(url in urls for url in re.findall(r"https?://[^\s<>\])]+",text))
    if card=="rebalance" and not cited(row.get("Analyst/Source"),observed):
        return None
    if card=="technical":
        evidence = row.get("Evidence source and as-of")
        daily = [r for r in records if r["kind"]=="daily_bar"]
        if not cited(evidence,provider_sources) and (len({r["as_of"][:10] for r in daily})<5 or not cited(evidence,{r["url"] for r in daily})):
            return None
    if card=="threats":
        row={**row,"Evidence":json.dumps([item for item in json_items(row.get("Evidence")) if isinstance(item.get("source_url"),str) and item["source_url"] in observed])}
    if card=="pairwise":
        judgments=[]
        for item in json_items(row.get("Judgments")):
            opponent=item.get("opponent_id")
            if not isinstance(opponent,str):
                continue
            other={r["url"] for r in research.get("listings",{}).get(opponent,[]) if r["kind"]!="filing_index"}
            refs=item.get("source_refs")
            if not isinstance(refs,list):
                continue
            refs=[r for r in refs if isinstance(r,dict) and isinstance(r.get("url"),str) and r["url"] in observed|other]
            judgments.append({**item,"source_refs":refs})
        row={**row,"Judgments":json.dumps(judgments)}
    return row


def project(card, manifest, jobs):
    stocks = manifest["stocks"]
    keys = [s["listing"] for s in stocks]
    slots, raw, votes, errors = defaultdict(dict),defaultdict(list),defaultdict(dict),[]
    model_tables = []
    for job, slot, assigned, pairs, *packet in jobs:
        rows, error = {}, str(getattr(job, "error_message", None) or job.status)
        # A prior worker may have rejected a valid scorecard accompanied by
        # verification notes or an exact venue-qualified label. Only reparse those failures.
        old_table_rejection = (job.status == "failed" and card in {"technical", "threats", "pairwise"}
                               and error.endswith(("returned invalid output contract (Response requires one well-formed table)",
                                                   "returned invalid output contract (no assigned listings)")))
        if job.status in ("partial", "completed") or old_table_rejection:
            rows, error = parse_rows(job.response, card, set(assigned))
        if error:
            errors.append({"job_id":job.id,"reason":error})
        if card == "rebalance":
            model_tables.append({"job_id":job.id, "slot":slot+1, "model":job.model, "rows":list(rows.values())})
        rows={key:r for key,raw_row in rows.items() if (r:=supported_row(raw_row,card,key,packet[0] if packet else None,job)) is not None}
        for key,r in rows.items():
            raw[key].append(r)
            slots[slot][key] = r
        for left,right in pairs:
            verdicts = [v for v in json_items(rows.get(left,{}).get("Judgments")) if v.get("opponent_id")==right]
            v = verdicts[0] if len(verdicts)==1 else None
            if v and (v.get("result") not in (left,right,"TIE","UNKNOWN") or not v.get("rationale") or not v.get("source_refs")):
                v = None
            if v and v["result"] != "UNKNOWN":
                refs = v["source_refs"]
                if not isinstance(refs, list) or not any(isinstance(ref, dict) and dated_reference(
                    f"{ref.get('url', '')} {ref.get('as_of', '')}", manifest["as_of"]) for ref in refs):
                    v = None
            earlier = votes[(left,right)].get(slot)
            if v and v["result"]!="UNKNOWN" or not earlier or earlier["result"]=="UNKNOWN":
                votes[(left,right)][slot]={**v,"job_id":job.id,"slot":slot+1} if v else None
    threat_slots = [threats_by_slot(rows,manifest["as_of"]) for rows in slots.values()] if card=="threats" else []
    pairwise = pair_results(votes,keys) if card=="pairwise" else {}
    result = []
    for stock in stocks:
        key = stock["listing"]
        if card=="rebalance":
            row = rebalance(raw[key],stock,manifest["as_of"])
        elif card=="technical":
            row = technical(raw[key],manifest["as_of"])
        elif card=="threats":
            row = threats(key,threat_slots,raw[key])
        else:
            row = pairwise[key]
        if row["score"] is None:
            row.update(coverage="Unassessed",reason="Insufficient verified observations")
        result.append({"listing":key,**row})
    return {"rows":result,"errors":errors,"model_tables":model_tables,"job_ids":[j.id for j,*_ in jobs]}

