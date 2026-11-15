"""Select list metadata in PostgreSQL without decoding candidate arrays in HTTP."""
from sqlalchemy import JSON, case, cast, column, func, literal, select, true
from sqlalchemy.dialects.postgresql import aggregate_order_by


HISTORY_OUTPUT_KEYS = (
    "workflow_stage_key", "phase_status", "total_items", "scanned_candidates",
    "completed_items", "accepted_candidates_count", "stage1_accepted_candidate_count",
    "failed_items", "llm_candidate_count", "stage2_eligible_rows_total",
    "stage2_reviewed_rows", "llm_usable_provider_target_count",
    "llm_successful_provider_target_count", "llm_failed_provider_target_count",
    "llm_failed_model_count", "orders_planned", "orders_processed",
    "orders_submitted", "permanent_failure_count", "current_blockage",
    "execution_gate_reason", "error_message", "stage2_universe_blocker_summary",
)


def history_console_projection(record):
    """Parse each JSON object once, preserving every list field without heavy rows."""
    empty_array = cast(literal("[]"), JSON)
    empty_object = cast(literal("{}"), JSON)

    def object_fields(value, keys, name):
        safe = case((func.json_typeof(value) == "object", value), else_=empty_object)
        return func.json_to_record(safe).table_valued(
            *[column(key, JSON) for key in keys]
        ).render_derived(with_types=True).lateral(name)

    projection = object_fields(
        record.console_projection, ("version", "order_funnel", "stage_results"), "history_run"
    )
    raw_stages = projection.c.stage_results
    safe_stages = case(
        (func.json_typeof(raw_stages) == "array", raw_stages), else_=empty_array,
    )
    stages = func.json_array_elements(safe_stages).table_valued(
        column("value", JSON), with_ordinality="ordinality"
    ).render_derived(name="history_stage")
    stage_keys = (
        "stage_number", "stage_name", "status", "reason", "started_at", "completed_at",
    )
    stage = object_fields(stages.c.value, (*stage_keys, "outputs"), "history_fields")
    outputs = object_fields(stage.c.outputs, HISTORY_OUTPUT_KEYS, "history_counts")
    projected_outputs = func.json_build_object(*[
        item for key in HISTORY_OUTPUT_KEYS for item in (key, outputs.c[key])
    ])
    projected_stage = func.json_build_object(*[
        item for key in stage_keys for item in (key, stage.c[key])
    ], "outputs", projected_outputs)
    stage_list = select(func.json_agg(
        aggregate_order_by(projected_stage, stages.c.ordinality), type_=JSON,
    )).select_from(stages).join(stage, true()).join(outputs, true()).correlate(
        record, projection
    ).scalar_subquery()
    return select(func.json_build_object(
        "version", projection.c.version,
        "order_funnel", projection.c.order_funnel,
        "stage_results", func.coalesce(stage_list, empty_array),
        type_=JSON,
    )).select_from(projection).correlate(record).scalar_subquery()
