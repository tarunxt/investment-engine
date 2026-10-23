"""Exact canonical source inventory, without policy approval or activation.

Every table/field has a disposition. Explicit principal paths never assign
orphans to the caller. Actor/subject or parent mismatches quarantine the export;
raw shared blob/outbox payloads and safety controls require typed resolvers.
"""
from sqlalchemy import select,exists,and_,or_
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.public_service.store import owner
from .sql_account import AccountInventory,AccountTableRule,OwnerHop,SQLAccountReader,schema_digest,_credential_column,APPLICATION_OWNER_SEMANTICS

EXPECTED_SCHEMA='f4d121c269ba11c1bd8730794947f5fd86e7a190a36bed7dd9f9d4ed3e5b83f8'
DIRECT_USER=frozenset(['activity_logs', 'administrative_role_grants', 'api_keys', 'api_usage_attempt_events', 'auto_rebalance_workflows', 'bullpen008_alerts', 'bullpen008_contingent_exit_activations', 'bullpen008_contingent_exit_policies', 'bullpen008_daily_equity_baselines', 'bullpen008_drawdown_episodes', 'bullpen008_evidence_packets', 'bullpen008_joint_loss_scenarios', 'bullpen008_loss_prevention_audits', 'bullpen008_pnl_attributions', 'bullpen008_quote_observations', 'bullpen008_regime_change_episodes', 'bullpen008_risk_classifications', 'bullpen008_runs', 'bullpen008_scenario_cooldowns', 'bullpen008_scenario_exposure_snapshots', 'bullpen008_scenario_memberships', 'bullpen008_settings', 'bullpen008_states', 'bullpen_run_audit_snapshots', 'bullpen_trade_analyses', 'dashboard_portfolio_daily_snapshots', 'google_sheets_credentials', 'idempotency_operations', 'indmoney_us_portfolio_snapshots', 'jobs', 'llm_provider_usage_calls', 'llm_provider_usage_daily_snapshots', 'polymarket_auto_live_capital_reservations', 'polymarket_auto_live_decisions', 'polymarket_auto_live_order_intents', 'polymarket_auto_live_positions', 'polymarket_auto_live_runs', 'polymarket_auto_live_settings', 'polymarket_auto_live_states', 'polymarket_redeem_attempts', 'prompts', 'runs', 'universal_scan_settings', 'universal_scan_states', 'user_module_preferences', 'user_profiles', 'user_sessions', 'zerodha_audit_logs', 'zerodha_credentials', 'zerodha_portfolio_snapshots'])
DIRECT_OWNER=frozenset(['confirmed_order_intents', 'integration_connections'])
APPLICATION_TABLES=frozenset(['recommendation_decisions', 'recommendation_evidence', 'recommendation_spend_accounts', 'recommendation_spend_attempts', 'recommendation_verifications'])
SHARED_RETAINED=frozenset(['cost_recommendations', 'cost_snapshots', 'fx_rates', 'google_sheets_app_configs', 'sports_ranking_snapshots', 'traffic_cost_rollups'])
SPECIAL_RETAINED=frozenset(['bullpen_run_audit_blobs', 'order_execution_fences', 'outbox'])
INDIRECT={'auto_rebalance_workflow_stages': ([('auto_rebalance_workflows', ('workflow_id',), ('id',))], 'user_id'), 'bullpen008_action_plans': ([('bullpen008_runs', ('run_id',), ('id',))], 'user_id'), 'bullpen008_execution_attempts': ([('bullpen008_execution_intents', ('intent_id',), ('id',)), ('bullpen008_runs', ('run_id',), ('id',))], 'user_id'), 'bullpen008_execution_events': ([('bullpen008_execution_intents', ('intent_id',), ('id',)), ('bullpen008_runs', ('run_id',), ('id',))], 'user_id'), 'bullpen008_execution_intents': ([('bullpen008_runs', ('run_id',), ('id',))], 'user_id'), 'bullpen008_portfolio_certificates': ([('bullpen008_runs', ('run_id',), ('id',))], 'user_id'), 'bullpen008_stage_outputs': ([('bullpen008_runs', ('run_id',), ('id',))], 'user_id'), 'bullpen_run_audit_events': ([('bullpen_run_audit_snapshots', ('snapshot_id',), ('id',))], 'user_id'), 'bullpen_run_audit_feedback': ([('bullpen_run_audit_snapshots', ('snapshot_id',), ('id',))], 'user_id'), 'bullpen_run_audit_feedback_subcalls': ([('bullpen_run_audit_feedback', ('feedback_id',), ('id',)), ('bullpen_run_audit_snapshots', ('snapshot_id',), ('id',))], 'user_id'), 'bullpen_run_audit_findings': ([('bullpen_run_audit_snapshots', ('snapshot_id',), ('id',))], 'user_id'), 'bullpen_run_audit_formulas': ([('bullpen_run_audit_snapshots', ('snapshot_id',), ('id',))], 'user_id'), 'bullpen_run_audit_manual_checks': ([('bullpen_run_audit_snapshots', ('snapshot_id',), ('id',))], 'user_id'), 'bullpen_run_audit_remarks': ([('bullpen_run_audit_snapshots', ('snapshot_id',), ('id',))], 'user_id'), 'bullpen_run_audit_stages': ([('bullpen_run_audit_snapshots', ('snapshot_id',), ('id',))], 'user_id'), 'bullpen_trade_analysis_event_logs': ([('bullpen_trade_analyses', ('trade_analysis_id',), ('id',))], 'user_id'), 'bullpen_trade_analysis_llm': ([('bullpen_trade_analyses', ('trade_analysis_id',), ('id',))], 'user_id'), 'bullpen_trade_analysis_snapshots': ([('bullpen_trade_analyses', ('trade_analysis_id',), ('id',))], 'user_id'), 'confirmed_order_legs': ([('confirmed_order_intents', ('intent_id',), ('id',))], 'owner_id'), 'connection_attempts': ([('integration_connections', ('connection_id', 'owner_id'), ('id', 'owner_id'))], 'owner_id'), 'connection_binding_history': ([('integration_connections', ('connection_id', 'owner_id'), ('id', 'owner_id'))], 'owner_id'), 'connection_credentials': ([('integration_connections', ('connection_id', 'owner_id'), ('id', 'owner_id'))], 'owner_id'), 'final_actionable_history': ([('runs', ('rebalance_run_id',), ('id',))], 'user_id'), 'order_execution_attempts': ([('order_execution_runs', ('intent_id',), ('intent_id',)), ('confirmed_order_intents', ('intent_id',), ('id',))], 'owner_id'), 'order_execution_runs': ([('confirmed_order_intents', ('intent_id',), ('id',))], 'owner_id'), 'polymarket_auto_live_order_attempts': ([('polymarket_auto_live_order_intents', ('intent_id',), ('id',))], 'user_id'), 'run_jobs': ([('jobs', ('job_id',), ('id',))], 'user_id'), 'user_modules': ([('user_module_preferences', ('user_id',), ('user_id',))], 'user_id')}


def canonical_inventory(metadata, *, reference):
    """Build source-bound projections; reference identifies review, never consent.

    Shared records and unresolved typed payloads are explicitly retained. This
    inventory alone neither authorizes deletion nor proves all cross-row integrity.
    Consumers must still run the reader/workflow validation and policy fences.
    """
    if type(reference) is not str or not reference.strip() or len(reference) > 120:
        raise BoundaryDenied('ACCOUNT_INVENTORY_REVIEW_REQUIRED')
    categories = [set(DIRECT_USER), set(DIRECT_OWNER), set(APPLICATION_TABLES),
                  set(SHARED_RETAINED), set(SPECIAL_RETAINED), set(INDIRECT), {'users'}]
    names = set().union(*categories)
    if sum(map(len, categories)) != len(names) or names != set(metadata.tables):
        raise BoundaryDenied('CANONICAL_ACCOUNT_CLASSIFICATION_CHANGED')
    if schema_digest(metadata) != EXPECTED_SCHEMA:
        raise BoundaryDenied('CANONICAL_ACCOUNT_SCHEMA_CHANGED')
    rules = []
    for name, table in sorted(metadata.tables.items()):
        if name in SHARED_RETAINED or name in SPECIAL_RETAINED:
            reason = ('shared platform data retained; no account ownership inferred' if name in SHARED_RETAINED
                      else 'typed ownership resolver required; raw payload/safety control retained')
            rules.append(AccountTableRule(name, (), excluded_reason=reason))
            continue
        withheld = tuple(c.name for c in table.columns if _credential_column(c.name))
        exported = tuple(c.name for c in table.columns if c.name not in withheld)
        hops, column = INDIRECT.get(name, ([], 'id' if name == 'users' else
                                           'owner_id' if name in DIRECT_OWNER else 'user_id'))
        rules.append(AccountTableRule(name, exported, withheld,
            tuple(OwnerHop(parent, tuple(local), tuple(remote)) for parent, local, remote in hops),
            column, owner_semantics=APPLICATION_OWNER_SEMANTICS if name in APPLICATION_TABLES else ''))
    return AccountInventory(reference, EXPECTED_SCHEMA, tuple(rules))


def classification(metadata):
    """Non-sensitive source manifest including explicit quarantines and limits."""
    inventory = canonical_inventory(metadata, reference='source-classification-not-legal-approval')
    return {
        'schema_digest': inventory.schema_digest,
        'tables': {r.table: {'principal_column': None if r.excluded_reason else r.owner_column,
            'path': [h.parent_table for h in r.path], 'export_columns': list(r.export_columns),
            'withheld_columns': list(r.withheld_columns), 'retained_reason': r.excluded_reason,
            'retained_columns': list(metadata.tables[r.table].c.keys()) if r.excluded_reason else []}
            for r in inventory.rules},
        'runtime_binding': False, 'legal_approval': False, 'complete_account_export': False,
        'complete_account_erasure': False,
        'limits': ['typed shared ownership unresolved', 'arbitrary unlabeled secrets not detected',
                   'cross-row integrity validation required before use',
                   'retention, identity and backup policy not approved'],
    }


def assert_owned_relationships(db, metadata, owner_id):
    """Reject foreign/missing parents before releasing any canonical projection.

    This is a read-only integrity preflight, not an erasure authorization. Shared
    payload tables remain excluded; their reverse ownership needs typed resolvers.
    Caller must preserve its snapshot/locks through the subsequent export.
    """
    if (db.get_bind().dialect.name == 'postgresql' and
        db.connection().get_isolation_level() not in {'REPEATABLE READ', 'SERIALIZABLE'}):
        raise BoundaryDenied('CANONICAL_ACCOUNT_SNAPSHOT_REQUIRED')
    inventory = canonical_inventory(metadata, reference='canonical-integrity-preflight')
    reader = SQLAccountReader(db, metadata, inventory).validate()
    owner(db, owner_id, verified=True)
    rules = {r.table: r for r in inventory.rules if not r.excluded_reason}
    from .privacy_relations import relationships
    for edge in relationships(metadata):
        if edge.child not in rules or edge.parent not in rules:
            continue  # Explicit retained/shared category; never assign ownership.
        child = metadata.tables[edge.child].alias('privacy_child')
        parent = metadata.tables[edge.parent].alias('privacy_parent')
        parent_owned = reader._predicate(parent, rules[edge.parent], owner_id)
        # Source API permits cloning visible system prompts. This exception is
        # exact to that FK, not a general relaxation for nullable owner columns.
        if (edge.child, edge.child_columns, edge.parent) == ('prompts', ('source_prompt_id',), 'prompts'):
            parent_owned = or_(parent_owned, parent.c.is_system.is_(True))
        matching_parent = exists(select(1).select_from(parent).where(
            and_(*(child.c[a] == parent.c[b] for a, b in zip(edge.child_columns, edge.parent_columns))),
            parent_owned)).correlate(child)
        invalid = db.scalar(select(1).select_from(child).where(
            reader._predicate(child, rules[edge.child], owner_id),
            and_(*(child.c[c].is_not(None) for c in edge.child_columns)),
            ~matching_parent).limit(1))
        if invalid is not None:
            raise BoundaryDenied('CANONICAL_ACCOUNT_RELATIONSHIP_HELD')
    return reader
