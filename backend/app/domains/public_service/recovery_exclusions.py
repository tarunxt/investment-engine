"""Explicit source-store exclusions: no live financial/operator restore.

Stage 17 requires rollback without order replay. Selected disposable adapters
cannot establish settlement of legacy external orders or revive operator grants.
"""
EXCLUDED={
 'polymarket_auto_live_order_intents':'External order acknowledgement/settlement and reservation reconciliation unavailable',
 'polymarket_auto_live_positions':'External position/exit authority cannot be restored from a row snapshot',
 'polymarket_auto_live_capital_reservations':'Never refund or re-reserve external capital by restoring a row',
 'polymarket_auto_live_runs':'Legacy live work has no supported disposable authority quarantine',
 'polymarket_auto_live_settings':'Automatic live execution settings must not be revived by privacy restore',
 'polymarket_auto_live_states':'Live scheduler/execution authority must remain disabled',
 'polymarket_auto_live_decisions':'Decisions tied to external effects require their original evidence/settlement',
 'polymarket_redeem_attempts':'An uncertain external redemption must not be repeated',
 'administrative_role_grants':'Restoration must not grant operator or administrator authority',
 'bullpen008_contingent_exit_activations':'Restoration must not reactivate external exit work',
 'bullpen008_contingent_exit_policies':'Restoration must not restore automatic exit authority',
 'bullpen008_settings':'Legacy operator/live settings need a dedicated authority quarantine',
 'bullpen008_states':'Legacy scheduler/live state must not be resumed',
 'connection_credentials':'Credential restoration/rotation is outside synthetic privacy authority',
 'connection_attempts':'One-use external authorization capabilities must not be revived',
 'google_sheets_credentials':'External send/export credentials must not be restored',
 'zerodha_credentials':'Broker credentials must not be restored',
}


def disposition(name):
    return {'store':name,'restore_allowed':False,'live_effects_allowed':False,
        'reason':EXCLUDED.get(name,'Store-specific reviewed adapter required'),
        'complete_account_erasure':False}
