"""Presentation surfaces reference the existing catalogue; never grant authority.

The browser consumes this typed manifest instead of maintaining a second module
registry. Core safety/account routes remain independent of optional selections.
"""
from .registry import ModuleId,INTERNAL_ANALYSIS_CONSUMERS

# Longest prefix wins. These are product surfaces, not new modules.
SURFACES = (
 ('/console/zerodha','India Portfolio',('zerodha_rebalance',)),
 ('/console/zerodha-swing-run','India analysis',('zerodha_rebalance',)),
 ('/console/auto-rebalance-runs/zerodha','India history',('zerodha_rebalance',)),
 ('/console/indmoney-us','US Portfolio',('indmoney_us',)),
 ('/console/indmoney-us-swing-run','US analysis',('indmoney_us',)),
 ('/console/auto-rebalance-runs/indmoneyUs','US history',('indmoney_us',)),
 ('/console/automated-rebalance','Portfolio analysis',('zerodha_rebalance','indmoney_us')),
 ('/console/bullpen-ai-auto-live','Bullpen Live',('bullpen_live',)),
 ('/console/trading-bots/bullpen-ai-auto-live','Bullpen Live',('bullpen_live',)),
 ('/console/bullpen-ai','Bullpen Research',('bullpen_research',)),
 ('/console/bullpen-sports','Bullpen Sports',('bullpen_research',)),
 ('/console/bullpen008','Bullpen Research',('bullpen_research',)),
 ('/console/polymarket-bot','Copy Trader',('copy_trader',)),
 ('/console/polymarket-direct-bot','Prediction Direct',('prediction_direct',)),
 ('/console/trading-bots','Trading Bots',('bullpen_research','bullpen_live','copy_trader','prediction_direct')),
 ('/console/technical-setups','Market Scanner',('market_scanner',)),
 ('/console/prompts','AI Studio prompts',('ai_studio',)),
 ('/console/llms','AI Studio',('ai_studio',)),
 ('/console/google-sheets','Sheets Export',('sheets_export',)),
 ('/console/sports-rankings','Sports Rankings',('sports_rankings',)),
)
# API prefixes used to stop browser polling before optional requests are issued.
# Server route/effect enforcement remains authoritative, including safety reads.
API_PREFIXES = (
 ('/uat2/simulation/buy-threshold/india',('zerodha_rebalance',)),
 ('/uat2/simulation/buy-threshold/indmoney_us',('indmoney_us',)),
 ('/uat2/simulation/recommendation-history/india',('zerodha_rebalance',)),
 ('/uat2/simulation/recommendation-history/indmoney_us',('indmoney_us',)),
 ('/zerodha',('zerodha_rebalance',)),('/indmoney-us',('indmoney_us',)),
 ('/bullpen-ai-auto-live',('bullpen_live',)),('/polymarket-auto-live',('bullpen_live',)),
 ('/bullpen-ai',('bullpen_research',)),('/bullpen008',('bullpen_research',)),
 ('/polymarket-direct',('prediction_direct',)),('/polymarket-bot',('copy_trader',)),
 ('/polymarket/auto-live',('bullpen_live',)),('/polymarket',('bullpen_research',)),('/technical-setups',('market_scanner',)),
 ('/google-sheets',('sheets_export',)),('/sports-rankings',('sports_rankings',)),
 ('/prompts',('ai_studio',)),('/providers',tuple(sorted(m.value for m in INTERNAL_ANALYSIS_CONSUMERS))),
)
CORE_PATHS=('/console/profile','/console/uat2','/console/apis','/console/mails','/console/jobs','/console/runs')

def presentation_manifest():
    assert all(ModuleId(m) for _,_,ids in SURFACES for m in ids)
    return {'schema_version':1,'surfaces':[{'path':path,'label':label,'module_ids':list(ids),'capability':'view'} for path,label,ids in SURFACES],
        'api_rules':[{'path':path,'module_ids':list(ids),'capability':'view'} for path,ids in API_PREFIXES]+[{'path':'/runs/auto-rebalance-history','module_ids':[module],'capability':'view','query_params':{'portfolio':portfolio}} for portfolio,module in [('india','zerodha_rebalance'),('indmoney_us','indmoney_us')]]+ [{'path':'/runs/auto-rebalance-history/'+portfolio,'module_ids':[module],'capability':'view'} for portfolio,module in [('india','zerodha_rebalance'),('indmoney_us','indmoney_us')]],
        'core_paths':list(CORE_PATHS),'safety_activity_path':'/console/profile/activity',
        'preferences_path':'/console/profile/preferences','connections_path':'/console/profile/connections'}
