"""Generate a private browser-test manifest from the canonical server catalogue."""
from pathlib import Path
import json,sys
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'backend'))
from app.domains.modules.registry import REGISTRY,platform_available
from app.domains.modules.presentation import presentation_manifest

def fixture():
    modules=[]
    for id,spec in REGISTRY.items():
        available,reason=platform_available(spec,uat2=False);selected=id.value in {'ai_studio','zerodha_rebalance'}
        modules.append({'module_id':id.value,'label':spec.label,'category':spec.category,
            'selection':{'enabled':selected,'version':1,'schedules_paused':True,'config':{'schema_version':1}},
            'availability':{'available':available,'reason':reason},'entitlement':{'jurisdiction':'allowed','plan':'allowed'},
            'connection':{'kind':spec.connection,'state':'not_required' if spec.connection in {'none','manual_import'} else 'ready'},
            'execution':{'capable':False,'action_confirmed':False},'requires':[x.value for x in spec.requires],
            'capabilities':{cap:{'allowed':selected and available and cap in {'view','analyze'},'reasons':[] if selected and available else ['MODULE_NOT_SELECTED'],'owner_id':71,'module_id':id.value,'capability':cap,'boundary':'http','selection_version':1} for cap in spec.capabilities}})
    return {'schema_version':1,'owner_id':71,'version':1,'modules':modules,'presentation':presentation_manifest(),'operational_enforcement_complete':False}
p=ROOT/'frontend/tests/fixtures/stage08-ready-manifest.json';text=json.dumps(fixture(),indent=2,sort_keys=True)+'\n'
if '--check' in sys.argv:assert p.read_text()==text,'Stage08 browser fixture stale'
else:p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
print('Canonical synthetic Stage08 browser fixture verified')
