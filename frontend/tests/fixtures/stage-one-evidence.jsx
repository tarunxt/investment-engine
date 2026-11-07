import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {StageOneOutputDialog,buildRunDetailScanCandidateDialogState} from '../../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard';
const params=new URLSearchParams(location.search),mode=params.get('mode'),profile=params.get('workspace');
const stamp='2026-11-01T00:00:00Z';
const outputs={phase_status:'completed',filters_completed_at:stamp,wallet_snapshot_status:'fresh',wallet_snapshot_freshness_state:'fresh',active_positions_found:[],available_for_claim:[],accepted_candidates:[]};
if(mode==='missing'||mode==='loading')for(const k of Object.keys(outputs))delete outputs[k];
if(mode==='failed')outputs.phase_status='failed';if(mode==='partial')outputs.partial_scan=true;if(mode==='stale')outputs.wallet_snapshot_freshness_state='stale';if(mode==='missing-arrays'){delete outputs.active_positions_found;delete outputs.available_for_claim;delete outputs.accepted_candidates;}
if(mode==='positive'){outputs.active_positions_total=3;outputs.available_for_claim=[{},{}];}
const stage={outputs,timerCompletedAt:['missing','loading'].includes(mode)?null:stamp,state:mode==='loading'?'current':'finished',scanCandidates:[],scannedCandidates:[],activePositionsFound:[]};
const run=mode==='missing'?null:{id:'saved-run',stage_results:[],request_context:{}};
const state=buildRunDetailScanCandidateDialogState({run,decisions:[],stage,mode:'active-positions'});
function App(){const[open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>Stage 1 details</button><a href='#background'>Background</a>{open&&<StageOneOutputDialog state={state} workspaceProfile={profile} onClose={()=>setOpen(false)}/>}</>;}
createRoot(document.getElementById('root')).render(<App/>);
