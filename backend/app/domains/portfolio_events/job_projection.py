"""Bound job reads to the columns used by captured analysis serializers."""

from sqlalchemy.orm import Load, load_only

from app.domains.jobs.models import Job


def portfolio_analysis_job_projection(
    *,
    include_details: bool,
    include_runtime_metadata: bool = False,
) -> Load:
    # History extracts snapshot provenance from the saved prompt but never
    # parses response bodies. Keep rebalance labels for threat history while
    # leaving large model output, search evidence, and runtime JSON in the DB.
    columns = [
        Job.id,
        Job.user_id,
        Job.prompt,
        Job.provider,
        Job.model,
        Job.status,
        Job.error_message,
        Job.estimated_cost,
        Job.auto_rebalance_portfolio,
        Job.auto_rebalance_sequence,
        Job.auto_rebalance_label,
        Job.created_at,
        Job.updated_at,
    ]
    if include_details:
        columns.extend([Job.response, Job.tokens_in, Job.tokens_out])
        if include_runtime_metadata:
            columns.append(Job.runtime_metadata_json)
    # Catch new serializer fields explicitly instead of issuing hidden async
    # lazy loads when another field is added to a response contract.
    return load_only(*columns, raiseload=True)
