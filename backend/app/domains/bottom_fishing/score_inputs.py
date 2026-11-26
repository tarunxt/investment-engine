"""Resolve the inputs for the Bottom Fishing scorecard without changing its Stage 2 output."""
from app.domains.scorecards.universe import digest


async def plan(db, owner, settings):
    from app.domains.scorecards.screener_inputs import selections
    choices, outputs, prefs = await selections(db, owner, "bfs", ["bottom"], live_bottom=True)
    choices, prefs = choices["bottom"], prefs["bottom"]
    from . import store
    from app.domains.scorecards.screener_inputs import preference_key
    version, _ = await store.latest(db, owner, preference_key("bfs", "bottom"), {})
    current = "bottom" not in prefs and (bool(version) or "bottom" in settings.get("inputs", ["bottom"]))
    if current and not prefs and len(choices) == 1 and "bottom" in settings.get("inputs", ["bottom"]):
        return None
    sources = {}
    for source, ids in choices.items():
        for run_id in ids:
            for row in outputs[source].get(run_id, {}).get("rows", []):
                key = row["exchange"] + ":" + row["symbol"]
                refs = sources.setdefault(key, [])
                if source not in refs:
                    refs.append(source)
    return dict(current=current, runs=choices, sources=sources, fingerprint=digest([current, choices]))


def apply_candidates(settings, native, levels):
    plan = settings.get("score_inputs")
    if plan is None:
        return levels
    # Only listings eligible under the scorecard's own support criteria progress.
    allowed = set(plan["sources"])
    if plan["current"]:
        allowed.update(native)
    return {key: value for key,value in levels.items() if key in allowed}


def record_inputs(state, settings, native):
    plan = settings.get("score_inputs")
    if plan is None:
        return
    candidates = set(plan["sources"]) | (native if plan["current"] else set())
    state["scorecard_inputs"] = dict(current_bottom=plan["current"], runs=plan["runs"],
        candidate_count=len(candidates), evaluated_count=len(state["rows"]), fingerprint=plan["fingerprint"])
    for row in state["rows"]:
        key = row["symbol"]
        row["sources"] = list(dict.fromkeys((["bottom"] if plan["current"] and key in native else []) + plan["sources"].get(key, [])))


def scoring_settings(settings):
    # Stage 3's selected sources have already been resolved and intersected with eligible setups.
    return {**settings, "inputs": ["bottom"]} if settings.get("score_inputs") else settings


async def filter_paper(client, cache, guard, settings, stamp, calendar, levels, series, state, coverage):
    from .query_evidence import apply_screen
    plan = settings.get("score_inputs")
    if plan is None:
        native_levels = await apply_screen(client,cache,guard,settings,stamp,calendar,levels,series,state,coverage)
        return native_levels, set(native_levels) | set(state["setups"])
    # Apply the native query independently. Other screeners supply their own verified candidates.
    from .discovery import Discovery
    same_rules = ((state.get("discovery") or Discovery().model_dump())
                  == (settings.get("discovery") or Discovery().model_dump()))
    carried = state["setups"].copy() if same_rules else {}
    native_levels = await apply_screen(client,cache,guard,settings,stamp,calendar,levels,series,state,coverage)
    native = set(native_levels) | set(state["setups"])
    state["setups"] = apply_candidates(settings, native, carried)
    return apply_candidates(settings, native, levels), native
