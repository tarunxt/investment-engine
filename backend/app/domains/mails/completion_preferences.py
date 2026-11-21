"""Granular completion subscriptions; legacy switches remain API-compatible."""
STOCK_STAGES = (
    ("sync", "Stage 1 · Portfolio sync"),
    ("swing", "Stage 2 · Swing scan"),
    ("threats", "Stage 3 · Threats scorecard"),
    ("pairwise", "Stage 3 · Pairwise scorecard"),
    ("rebalance", "Stage 3 · Rebalance scorecard"),
    ("technical", "Stage 3 · Technical scorecard"),
    ("actionables", "Stage 4 · Final actionables"),
)
BULLPEN_STAGES = (
    ("scan", "Stage 1 · Bullpen scan"),
    ("llm", "Stage 2 · Run LLM"),
    ("invest", "Stage 3 · Exit and invest"),
)
COMPLETION_CATALOG = tuple(
    {
        "key": f"completion.{segment}.{stage}",
        "label": label,
        "description": "Email when this stage completes." if stage != "overall" else "Email when the overall workflow completes.",
        "category": "runs",
        "segments": (display,),
        "group": "completion",
    }
    for segment, display, stages in (
        ("zerodha", "Zerodha", STOCK_STAGES),
        ("indmoney", "IndMoney", STOCK_STAGES),
        ("bullpen", "Bullpen", BULLPEN_STAGES),
    )
    for stage, label in (*stages, ("overall", "Overall completion"))
)
COMPLETION_DEFAULTS = {
    item["key"]: item["key"] == "completion.bullpen.scan"
    or (item["key"].endswith(".overall") and ".bullpen." not in item["key"])
    for item in COMPLETION_CATALOG
}


def inherit_legacy_preferences(preferences, saved):
    for key in COMPLETION_DEFAULTS:
        if key in saved or ".bullpen." in key:
            continue
        legacy = "auto_rebalance_success" if key.endswith(".overall") else "run_completion"
        if isinstance(saved.get(legacy), bool):
            preferences[key] = saved[legacy]


def stock_segment(portfolio):
    return {"india": "zerodha", "us": "indmoney", "indmoney_us": "indmoney"}.get(portfolio)


def stock_run_preference(run):
    segment = stock_segment(run.auto_rebalance_portfolio)
    if not segment:
        return None
    label = (run.auto_rebalance_label or "").lower()
    prompt = (run.prompt or "").lower()
    if "pairwise scan" in label:
        stage = "pairwise"
    elif "threat" in label or "_threats]" in prompt:
        stage = "threats"
    elif "technical scan" in label or "## technical scan input bundle" in prompt:
        stage = "technical"
    elif "rebalance scan" in label or "[rebalance_flow:" in prompt:
        stage = "rebalance"
    else:
        stage = "swing"
    return f"completion.{segment}.{stage}"
