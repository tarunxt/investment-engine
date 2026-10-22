"""Source-only canonical route classification, shared by runtime and inventory.

No application imports, environment reads, database or network operations.
"""
DOMAIN_MODULES={
    'zerodha':'zerodha_rebalance','indmoney_us':'indmoney_us',
    'jobs':'ai_studio','runs':'ai_studio','prompts':'ai_studio','ai_providers':'ai_studio',
    'google_sheets':'sheets_export','sports_rankings':'sports_rankings',
    'polymarket':'copy_trader','polymarket_direct':'prediction_direct',
    'polymarket_auto_live':'bullpen_live','bullpen008':'bullpen_research',
    'bullpen_trade_analysis':'bullpen_research','bullpen_run_audit':'bullpen_research',
    'trading_bots':'market_scanner','recommendation_audit':'ai_studio',
}
# History and narrow cancellation are safety/account operations, not an all-jobs
# exemption. New work, stage updates, exports and notifications are module gated.
SAFETY_ROUTES={('GET','/jobs'),('GET','/jobs/{job_id}'),('DELETE','/jobs/{job_id}'),
    ('POST','/jobs/{job_id}/cancel'),('GET','/runs'),('GET','/runs/{run_id}'),
    ('DELETE','/runs/{run_id}'),('POST','/runs/{run_id}/cancel')}
SAFETY_ENDPOINTS={
 'polymarket':{'stop_polymarket_bot','emergency_stop_polymarket_live'},
 'polymarket_direct':{'stop_polymarket_bot','emergency_stop_polymarket_live'},
 'polymarket_auto_live':{'stop_auto_live','pause_auto_live','emergency_stop_auto_live','reconcile_auto_live_run_order_states','cancel_auto_live_order'},
 'bullpen008':{'stop_bullpen008_scheduler','pause_bullpen008_scheduler','activate_bullpen008_emergency_stop'},
}

CORE_DOMAINS={'connections','auth','modules','api_usage','cost_drivers','health','dashboard','mails'}


def classify_route(domain,endpoint,path,methods,source_module=''):
    methods=set(methods or ())
    if (domain=='order_intents' and endpoint=='approve' and methods=={'POST'}
            and path=='/order-intents/{id}/approve'):
        # Recording exact consent is preparation, not a broker effect. Require
        # the module's existing preparation entitlement here; the authenticated
        # handler consumes request-local confirmation and Orders.approve checks
        # the owned review/connection and fresh execute policy before persisting
        # approval. Never manufacture action_confirmed in generic HTTP policy.
        return ('zerodha_rebalance','analyze')
    if domain=='order_intents' and methods=={'GET'} and path in {'/order-intents/reviews','/order-intents/reviews/{id}','/order-intents/positions'}:
        return None # Authenticated owner safety observations; no execution exemption.
    if domain=='ai_limits' and methods=={'GET'} and path in {'/api-usage/limits','/api-usage/limits/private-artifacts/{artifact_id}'}:
        return None # Authenticated owned receipt/read paths enforce resource policy themselves.
    if domain=='ai_providers' and endpoint=='list_providers' and methods=={'GET'}:return ('__analysis_metadata__','view')
    if domain=='mails' and endpoint=='send_test_mail':return ('ai_studio','analyze')
    if domain=='runs' and path.startswith('/runs/analysis-workflows'):
        # Own read/control paths enforce owner + fresh dynamic module policy in
        # the service; cancellation/history remain available after disable.
        return None
    if domain=='public_service' and source_module=='app.domains.public_service.application_router' and len(methods)==1 and (next(iter(methods)),path,endpoint) in {
        ('GET','/account/operations/disposable/reviewed-eligibility','reviewed_eligibility'),
        ('POST','/account/operations/disposable/operational-queue','enqueue_operation'),
        ('POST','/account/operations/disposable/privacy-requests/{id}/execute','execute_privacy'),
        ('GET','/account/operations/disposable/privacy-requests/{id}/result','privacy_result')}:
        return None # Authenticated exact owner; test-only binding plus disposable DB fences remain mandatory.
    if domain=='public_service' and len(methods)==1 and (next(iter(methods),''),path) in {
        ('POST','/account/operations/privacy-requests'),('GET','/account/operations/privacy-requests/{id}'),
        ('POST','/account/operations/privacy-requests/{id}/cancel'),('GET','/account/operations/privacy-requests/{id}/export'),
        ('GET','/account/operations/eligibility'),('POST','/account/operations/eligibility'),
        ('GET','/account/operations/diagnostics'),('POST','/account/operations/support-consents'),
        ('POST','/account/operations/support-consents/{id}/revoke'),('GET','/account/operations/support-consents/{id}/access')}:
        return None # Authenticated owned account requests; no approval/effect endpoint.
    if domain in CORE_DOMAINS:return None
    if domain=='runs' and methods=={'GET'} and endpoint in {'list_runs','get_run','list_auto_rebalance_history','get_auto_rebalance_history_detail','get_final_actionable_history'}:return None
    if domain=='zerodha' and endpoint in {'get_login_url','callback','get_status','disconnect'}:return None
    if domain is None:
        if source_module=='app.uat2.router':
            # Existing synthetic read-only fixtures and status remain reviewable;
            # queue/order/email/export operations have the same optional policy.
            if path=='/uat2/ai':return ('ai_studio','analyze')
            if path=='/uat2/ai/{task_id}':return ('ai_studio','view')
            if path=='/uat2/email':return ('ai_studio','analyze')
            if path=='/uat2/export':return ('sheets_export','export')
            if path=='/zerodha/orders' and methods!={'GET'}:return ('zerodha_rebalance','execute')
        return None # root/health and explicitly synthetic read-only fixtures
    if endpoint in SAFETY_ENDPOINTS.get(domain,set()):return ('__safety__',endpoint)
    methods=methods or set()
    if all((method,path) in SAFETY_ROUTES for method in methods):return None
    if domain=='google_sheets' and endpoint in {'connect','callback','status','disconnect','get_connection_status','oauth_callback','get_auth_url','exchange_code','get_status','save_default_sheet','get_admin_config','update_admin_config'}:return None
    module='__analysis_consumer__' if domain=='runs' else DOMAIN_MODULES.get(domain)
    if module is None:return ('unknown','view')
    capability='view' if methods<={'GET','HEAD'} else 'analyze'
    if domain=='indmoney_us' and endpoint in {'preview_import','accept_import','create_portfolio_snapshot'}:capability='import'
    if 'export' in endpoint:module,capability='sheets_export','export'
    if domain=='zerodha' and endpoint in {'place_order','place_protected_market_orders','place_protected_market_orders_sequenced'}:capability='execute'
    if domain in {'polymarket_direct','polymarket_auto_live','polymarket','bullpen008'} and capability!='view':capability='execute'
    return module,capability

