"""Read-only projections of owned immutable captures. Never calculate or backfill."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import math

from sqlalchemy import select
from app.domains.runs.models import FinalActionableHistory
from .models import DecisionRecord, EvidenceRecord
from .schemas import SCORE_FIELDS, WEIGHT_KEYS, SCHEMA_VERSION

MATRIX_VERSION = "stored-score-matrix-v1"
RATIONALES = ("rationale_remarks", "rationale_technical_short_term", "rationale_technical_medium_term", "rationale_technical_long_term", "rationale_fundamentals_short_term", "rationale_fundamentals_medium_long_term")
LABELS = ("Average of Score Rationale Cruxx", "Average of Score Rationale - Technical Setup (Short Term 1–3 Months)", "Average of Score Rationale - Technical Setup (Medium Term)", "Average of Score Rationale - Technical Setup (Long Term)", "Average of Score Rationale - Fundamentals Short Term", "Average of Score Rationale - Fundamentals Medium/Long Term")
ACTIONS = {"Sell All", "Trim", "Hold", "Add more", "Buy New"}


def numeric(value):
    if value is None or isinstance(value, bool): return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError, OverflowError): return None


def instant(value):
    if isinstance(value, str):
        try: value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError: return None
    if not isinstance(value, datetime): return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def stored_matrix(payload):
    """Adapt recorded numbers/formula inputs, never invoke a decision algorithm."""
    if payload.get("schema_version") != SCHEMA_VERSION: return None
    calc, formula = payload.get("calculation") or {}, payload.get("formula") or {}
    score, denominator = numeric(calc.get("score")), numeric(calc.get("denominator"))
    action = calc.get("formula_action")
    if not formula or score is None or denominator is None or denominator <= 0 or action not in ACTIONS: return None
    weights = formula.get("detailedRationaleMultipliers") or {}
    averages = calc.get("averages") or {}
    if any(numeric(averages.get(key)) is None or numeric(weights.get(key)) is None for key in WEIGHT_KEYS): return None
    rows = [{"id": key, "parameter": label, "score": numeric(averages[key]), "multiplier": numeric(weights[key])} for key, label in zip(WEIGHT_KEYS, LABELS)]
    mode = calc.get("raw_action")
    mode_score = numeric((formula.get("actionScores") or {}).get(mode))
    if mode_score is not None and numeric(weights.get("mean-mode-action")) is not None:
        rows.append({"id": "mean-mode-action", "parameter": "Consolidated model action (captured formula input)", "score": mode_score, "multiplier": numeric(weights["mean-mode-action"])})
    technical = payload.get("technical") or {}
    if technical:
        bias_weight = numeric((formula.get("technicalScanMultipliers") or {}).get(technical.get("bias")))
        base_weight = numeric(weights.get("technical-scan-confidence"))
        if bias_weight is not None and base_weight is not None:
            rows.append({"id": "technical-scan-confidence", "parameter": "Technical Scan Confidence Score", "score": numeric(technical.get("confidence")), "multiplier": base_weight * bias_weight})
        for key, name, field in [("premarket-trend", "Technical Scan Premarket trend", "premarket"), ("last-5-candles-trend", "Technical Scan Last 5 candles trend", "last5")]:
            if numeric(weights.get(key)) is not None: rows.append({"id": key, "parameter": name, "score": numeric(technical.get(field)), "multiplier": numeric(weights[key])})
    samples = payload.get("samples") or []
    source_rows = [{"id": f"{payload['run_id']}-{sample.get('job_id')}-matrix", "source": f"Run #{payload['run_id']} · Job #{sample.get('job_id')} (Rebalance Scan)", "action": sample.get("row", {}).get("action") if sample.get("row", {}).get("action") in ACTIONS else None, "actionScore": None, "unitsChange": numeric(sample.get("row", {}).get("units_change")), "note": f"{sample.get('provider', 'Provider unavailable')} {sample.get('model', 'Model unavailable')} · original timestamp in source evidence"} for sample in samples]
    return {"stockKey": payload["symbol"], "stockSymbol": payload["symbol"], "stockName": next((s.get("row", {}).get("stock_name") for s in samples if s.get("row", {}).get("stock_name")), payload["symbol"]), "stockExchange": payload["exchange"],
            "currentUnits": numeric(calc.get("current_units")), "modeAction": mode if mode in ACTIONS else None, "meanScore": None, "meanUnitsChange": None,
            "calculatedScore": score, "meanModeAction": mode if mode in ACTIONS else None, "meanModeUnitsChange": None, "calculatedAction": action, "calculatedUnitsChange": numeric(calc.get("formula_units")),
            "matchedRuleId": "", "rules": [], "rows": source_rows, "detailedRationaleRows": rows, "detailedRationaleFinalScore": score, "detailedRationaleDenominator": denominator,
            "rebalanceSourceLabel": f"Run #{payload['run_id']} (Rebalance Scan)", "rebalanceSourceRunId": payload["run_id"], "technicalScanSourceLabel": None, "technicalScanSourceRunId": None,
            "historicalReadNotes": ["Score, action and denominator are copied from the immutable capture. Missing mean values and original rule annotations remain unavailable; no current formula was applied."]}


def parameter_observations(payload, outputs):
    """Keep each saved sample/job; do not average scores or select another revision."""
    result = {key: [] for key in WEIGHT_KEYS}
    for index, sample in enumerate(payload.get("samples") or []):
        if not isinstance(sample, dict): continue
        job_id = sample.get("job_id")
        if type(job_id) is not int: continue
        output = next((o for o in outputs if o.job_id == job_id), None)
        values = sample.get("source_values") if isinstance(sample.get("source_values"), dict) else sample.get("row") or {}
        created = output.payload.get("created_at") if output else None
        provider, model = sample.get("provider"), sample.get("model")
        label = f"Run #{payload['run_id']} (Rebalance Scan) · Job #{job_id} · {provider or 'Provider unavailable'} {model or 'Model unavailable'} · {created or 'Original timestamp unavailable'}"
        for key, score_field, rationale_field in zip(WEIGHT_KEYS, SCORE_FIELDS, RATIONALES):
            raw_rationale = values.get(rationale_field)
            rationale = str(raw_rationale) if raw_rationale not in (None, "", "—", "-", "N/A") else "Original parameter rationale was not captured."
            result[key].append({"id": f"{payload['run_id']}:{job_id}:{index}:{key}", "runId": payload["run_id"], "jobId": job_id, "label": label, "score": numeric(values.get(score_field)), "rationale": rationale,
                                "rawScore": values.get(score_field), "rawRationale": raw_rationale, "sourceHash": output.content_hash if output else None, "representation": "immutable_source_values" if isinstance(sample.get("source_values"), dict) else "immutable_normalized_sample"})
    # Technical samples are read only from the exact immutable output IDs captured in this decision.
    from .technical import technical_rows
    for output in outputs:
        if output.id not in (payload.get("technical") or {}).get("output_ids", []): continue
        row = technical_rows(output.content or "").get((payload["symbol"], payload["exchange"]))
        if not row: continue
        label = f"Run #{output.run_id} (Technical Scan) · Job #{output.job_id} · {output.payload.get('provider', 'Provider unavailable')} {output.payload.get('model', 'Model unavailable')} · {output.payload.get('created_at') or 'Original timestamp unavailable'}"
        for key, field in [("technical-scan-confidence", "confidence"), ("premarket-trend", "premarket"), ("last-5-candles-trend", "last5")]:
            result.setdefault(key, []).append({"id": f"{output.id}:{key}", "runId": output.run_id, "jobId": output.job_id, "label": label, "score": numeric(row.get(field)), "rawScore": row.get(field), "rawRationale": None, "rationale": "Parameter-specific rationale was not captured in this technical output.", "sourceHash": output.content_hash, "representation": "immutable_technical_output"})
    return result


def legacy_parameter_observations(history, exchange):
    """Project already-saved legacy raw cells; never assign the representative row to every LLM."""
    from collections import Counter
    from app.domains.runs.final_actionable_history import normalize_stock_symbol
    from app.domains.jobs.output_contracts.schemas import REBALANCE_COLUMNS
    from app.domains.jobs.output_contracts.validation import aliases, header_key
    known = aliases(REBALANCE_COLUMNS)
    rows = (history.snapshot_json or {}).get("rows")
    if history.formula_version != "legacy-backfill-v1" or not isinstance(rows, list): return {}, []
    matched = []
    for item in rows:
        if not isinstance(item, dict) or type(item.get("job_id")) is not int or not isinstance(item.get("raw"), dict): continue
        mapped = {}
        duplicate = False
        for header, value in item["raw"].items():
            key = known.get(header_key(header), header_key(header))
            if key in mapped: duplicate = True
            mapped[key] = value
        if duplicate: continue
        if normalize_stock_symbol(mapped.get("stock_symbol")) != history.stock_symbol.upper() or str(mapped.get("exchange_symbol") or "").upper() != exchange: continue
        matched.append((item, mapped))
    counts = Counter(item["job_id"] for item, _ in matched)
    result = {key: [] for key in WEIGHT_KEYS}
    notes = []
    if any(count > 1 for count in counts.values()): notes.append("Duplicate legacy stock rows for one job are ambiguous; that job was not counted as independent observations.")
    for item, values in matched:
        job_id = item["job_id"]
        if counts[job_id] != 1: continue
        label = f"Run #{history.rebalance_run_id} (Rebalance Scan) · Job #{job_id} · {item.get('provider') or 'Provider unavailable'} {item.get('model') or 'Model unavailable'} · original job timestamp not captured"
        for key, score_field, rationale_field in zip(WEIGHT_KEYS, SCORE_FIELDS, RATIONALES):
            raw_rationale = values.get(rationale_field)
            result[key].append({"id": f"legacy:{history.id}:{job_id}:{key}", "runId": history.rebalance_run_id, "jobId": job_id, "label": label, "score": numeric(values.get(score_field)), "rawScore": values.get(score_field), "rawRationale": raw_rationale, "rationale": str(raw_rationale) if raw_rationale not in (None, "", "—", "-", "N/A") else "Original parameter rationale was not captured.", "sourceHash": None, "representation": "saved_legacy_source_row"})
    return result, notes


def historical_score_view(session, *, user_id, run_id, market, symbol, exchange, covered_at, history_id=None):
    """Exact owner/run/stock/venue/instant lookup; retained audits need no Run/Job."""
    symbol, exchange = symbol.upper(), exchange.upper()
    target_time = instant(covered_at)
    if target_time is None: raise ValueError("An exact valid historical timestamp is required")
    history = None
    if history_id is not None:
        history = session.scalar(select(FinalActionableHistory).where(FinalActionableHistory.id == history_id, FinalActionableHistory.user_id == user_id))
        if history is None: raise LookupError("Historical selection not found")
        if (history.rebalance_run_id, history.market, history.stock_symbol.upper(), instant(history.covered_at)) != (run_id, market, symbol, target_time): raise LookupError("Historical selection scope does not match")
        native = history.formula_inputs_json or {}
        saved_exchange = native.get("stockExchange") or (history.snapshot_json or {}).get("representative", {}).get("Exchange Symbol")
        if saved_exchange and str(saved_exchange).upper() != exchange: raise LookupError("Historical exchange does not match")
    records = list(session.scalars(select(DecisionRecord).where(DecisionRecord.user_id == user_id, DecisionRecord.run_id == run_id, DecisionRecord.market == market, DecisionRecord.symbol == symbol, DecisionRecord.exchange == exchange, DecisionRecord.provenance != "calculation_observed").order_by(DecisionRecord.id).limit(201)))
    inputs = list(session.scalars(select(EvidenceRecord).where(EvidenceRecord.user_id == user_id, EvidenceRecord.run_id == run_id, EvidenceRecord.kind == "input").limit(201)))
    input_by_id = {i.id: i for i in inputs}
    matches = [r for r in records if target_time in {instant(r.payload.get("decision_at")), instant((input_by_id.get(r.payload.get("input_id")).payload if input_by_id.get(r.payload.get("input_id")) else {}).get("created_at"))}]
    if history is not None:
        if history.technical_scan_run_id is not None:
            matches = [r for r in matches if r.provenance == f"technical:{history.technical_scan_run_id}"]
        else:
            matches = [r for r in matches if not r.provenance.startswith("technical:")]
    scope = {"run_id": run_id, "market": market, "symbol": symbol, "exchange": exchange, "covered_at": target_time.isoformat(), "history_id": history_id}
    reply = {"scope": scope, "status": "missing", "matrix": None, "parameters": {}, "notes": [], "coverage": {"matching_captures": len(matches), "decision_records_examined": len(records), "input_records_examined": len(inputs)}, "candidates": [], "parameter_labels": dict(zip(WEIGHT_KEYS, LABELS)) | {"technical-scan-confidence": "Technical Scan Confidence Score", "premarket-trend": "Technical Scan Premarket trend", "last-5-candles-trend": "Technical Scan Last 5 candles trend"}}
    if len(records) > 200 or len(inputs) > 200 or len(matches) > 1:
        reply.update(status="ambiguous", notes=["Multiple or excessive immutable revisions match this exact selection; no latest revision was substituted."], candidates=[{"id": r.id, "captured_at": r.captured_at.isoformat(), "provenance": r.provenance} for r in matches[:200]])
        return reply
    if matches:
        record = matches[0]
        payload = record.payload
        if (payload.get("run_id"), payload.get("market"), payload.get("symbol"), payload.get("exchange")) != (run_id, market, symbol, exchange):
            reply["notes"].append("Stored capture payload identity is inconsistent; no source values were substituted.")
            return reply
        output_ids = list(dict.fromkeys([*(payload.get("output_ids") or []), *((payload.get("technical") or {}).get("output_ids") or [])]))
        outputs = list(session.scalars(select(EvidenceRecord).where(EvidenceRecord.user_id == user_id, EvidenceRecord.kind == "output", EvidenceRecord.id.in_(output_ids)))) if output_ids else []
        reply["parameters"] = parameter_observations(payload, outputs)
        matrix = deepcopy(payload.get("matrix_snapshot")) if payload.get("matrix_snapshot_version") == MATRIX_VERSION else stored_matrix(payload)
        if matrix and (matrix.get("stockSymbol"), matrix.get("stockExchange"), matrix.get("rebalanceSourceRunId")) != (symbol, exchange, run_id): matrix = None
        reply.update(status="available" if matrix else "partial", matrix=matrix, source="immutable_audit", capture_id=record.id, provenance=record.provenance, captured_at=record.captured_at.isoformat(), decision_at=record.decision_at.isoformat())
        if not matrix: reply["notes"].append("Original weighted matrix/formula or a complete calculated decision was not captured. Retained per-job parameter observations remain available.")
        if len(outputs) != len(output_ids): reply["notes"].append("Some output metadata is no longer present; saved decision samples are retained without inventing job timestamps.")
    else:
        reply["notes"].append("No immutable capture matches this exact run, stock, venue and timestamp. A historical formula cannot be recreated from today's settings.")
    if history is not None and not any(reply["parameters"].values()):
        legacy, notes = legacy_parameter_observations(history, exchange)
        if any(legacy.values()):
            reply.update(parameters=legacy, status="partial", source="saved_legacy_projection_parameters")
            reply["notes"].append("Saved legacy model rows retain parameter scores and rationales. Their original weighted formula/matrix was not captured; the legacy score and action remain unchanged.")
        reply["notes"].extend(notes)
    # A native history matrix is usable as a saved projection, never a fabricated legacy matrix.
    native = history.formula_inputs_json if history is not None and history.formula_version == "score-matrix-v1" else None
    if reply["matrix"] is None and isinstance(native, dict) and native.get("stockSymbol") == symbol and native.get("stockExchange") == exchange and native.get("rebalanceSourceRunId") == run_id and isinstance(native.get("detailedRationaleRows"), list) and isinstance(native.get("rows"), list) and isinstance(native.get("rules"), list) and numeric(native.get("calculatedScore")) == history.score:
        reply.update(matrix=deepcopy(native), status="available", source="saved_history_projection")
    if history is not None:
        reply["history_context"] = {"formula_version": history.formula_version, "score": history.score, "action": history.action}
        if reply["matrix"] is not None and history.score != reply["matrix"].get("calculatedScore"):
            reply["notes"].append("The history-list score and immutable calculated score represent different saved contexts. Neither value has been overwritten or used to recalculate the other.")
    reply["coverage"]["parameter_observations"] = sum(len(rows) for rows in reply["parameters"].values())
    return reply
