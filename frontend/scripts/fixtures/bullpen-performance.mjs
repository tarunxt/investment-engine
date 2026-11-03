/** Invented read-only benchmark responses. No account/provider calls or actions. */
export function bullpenPerformanceFixture(pathname, now) {
  if (/\/providers\/?$/.test(pathname)) return [];
  if (pathname.endsWith('/auth/profile')) return {id:1,email:'performance-fixture@example.invalid',username:'performance-fixture',full_name:'Performance Fixture',role:'admin',is_active:true,is_verified:true,created_at:now,updated_at:now,last_login:null,profile:null};
  const state={running:false,paused:false,dry_run:true,live_armed:false,live_execution_allowed:false,emergency_stopped:false,status:'stopped',mode:'dry-run',latest_guardrail_checks:[],invested_usd:0,current_value_usd:100,pnl_usd:0,active_positions:0,trades_today:0,consecutive_failed_orders:0};
  const settings={auto_live_enabled:false,strategy_profile:'console',console_llm_targets:[],console_scan_scope:'full_universe',console_order_usd:null,console_auto_start_at:null,console_auto_refresh_minutes:5,scan_interval_seconds:60};
  if(pathname.includes('/polymarket/auto-live/')){
    if(pathname.endsWith('/status'))return {source:'persisted',refreshed_at:now,configuration:{...settings},scheduler:{running:false,paused:false,emergency_stopped:false,status:'stopped',mode:'dry-run',next_run_at:null,last_run_at:null,last_run_id:null,active_run_id:null,active_run_status:null}};
    if(pathname.endsWith('/settings'))return settings;
    if(pathname.endsWith('/state'))return state;
    if(pathname.endsWith('/summary')||pathname.endsWith('/summary/dashboard'))return {state,settings,bot_card:{id:'bullpen-ai-auto-live',name:'Bullpen fixture',route:'/console/bullpen-ai',status:'stopped',mode:'dry-run',invested_usd:0,current_value_usd:100,pnl_usd:0,active_positions:0,trades_today:0,guardrails_summary:'Synthetic read-only fixture',strategy_summary:'No workflow is active',risk_summary:'No actions permitted',guardrails:[]},latest_run:null,recent_runs:[],recent_decisions:[],latest_guardrail_checks:[],generated_at:now};
    if(pathname.endsWith('/history'))return {items:[],total:0,page:1,size:20,total_pages:0};
    if(pathname.endsWith('/history/event-trends'))return {events:[],scan_count:0,generated_at:now};
  }
  if(pathname.endsWith('/polymarket/state'))return {read_source:'persisted',running:false,paused:false,mode:'mock',server_now:now,session_started_at:now,seconds_until_next_poll:0,tracked_accounts:[],tracked_traders:[],open_positions:[],trade_history:[],recent_activity:[],metrics:{total_pnl:0,win_rate:0,total_trades:0,winners:0,losers:0,skipped:0,failed:0},config:{},live:{enabled_by_env:false,unlocked:false,unlock_mode:'locked',manually_locked:true,emergency_stopped:false,doctor:{ok:true,message:'Synthetic read-only fixture'},balance:{status:'ready',message:'Synthetic balance',checked_at:now,account_value_usd:100,available_balance_usd:100,pnl_usd:0,upnl_usd:0},source_status:{source_mode:'mock',manual_tracked_wallets:[],manual_wallets_invalid:[]},max_live_trade_size:0,live_trades_today:0,pending_confirmations:[],recent_decisions:[],redeemed_trades:[]}};
  return null;
}
