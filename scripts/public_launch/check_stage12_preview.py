"""Real synthetic HTTP acceptance; fixture bearer tokens stay in memory."""
import json,time,urllib.request,urllib.error
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parents[2]
state=json.loads((ROOT/'.runtime/stage01-preview/state.json').read_text())
assert state['synthetic'] is True
base=state['backend_url'];assert base.startswith('http://127.0.0.1:')
checks=[]
def request(method,path,data=None,token=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    req=urllib.request.Request(base+path,data=json.dumps(data).encode() if data is not None else None,method=method,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=12) as response:status=response.status;body=response.read();cache=response.headers.get('Cache-Control')
    except urllib.error.HTTPError as error:status=error.code;body=error.read();cache=error.headers.get('Cache-Control')
    return status,json.loads(body) if body else None,cache

def check(name,value):
    assert value,name;checks.append(name)

def user(name):
    code,data,_=request('POST','/auth/login',{'email':name+'@stage01.example.com','password':'SyntheticPreview123!'})
    assert code==200
    token=data['access_token'];code,modules,_=request('GET','/me/modules',token=token);assert code==200
    code,_,_=request('PATCH','/me/modules',{'expected_version':modules['version'],'updates':[{'module_id':'indmoney_us','enabled':True}]},token)
    assert code==200
    return token

check('network-denied isolated fixture',request('GET','/preview-health')[1]['outbound_network']=='denied')
a,b=user('usera'),user('userb');path='/runs/analysis-workflows'
check('anonymous list denied',request('GET',path)[0] in {401,403})
code,config,_=request('GET',path+'/config',token=a)
check('explicit fake runtime has no order authority',code==200 and config=={'enabled':True,'analysis_only':True,'orders_authorized':False})
key='http-stage12-'+datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')
code,row,cache=request('POST',path,{'portfolio':'indmoney_us','key':key},a)
check('real create route and private cache',code==200 and cache=='private, no-store')
id=row['id'];detail=path+'/'+str(id)
check('idempotent repeated start',request('POST',path,{'portfolio':'indmoney_us','key':key},a)[1]['id']==id)
check('cross-owner detail denied',request('GET',detail,token=b)[0]==404)
check('cross-owner cancel denied',request('POST',detail+'/controls',{'portfolio':'indmoney_us','action':'cancel','version':0},b)[0]==404)
code,paused,_=request('POST',detail+'/controls',{'portfolio':'indmoney_us','action':'pause','version':0},a)
check('explicit pause persists',code==200 and paused['status']=='paused')
check('stale control denied',request('POST',detail+'/controls',{'portfolio':'indmoney_us','action':'resume','version':0},a)[0]==409)
code,resumed,_=request('POST',detail+'/controls',{'portfolio':'indmoney_us','action':'resume','version':paused['version']},a)
check('explicit resume uses current receipt',code==200 and resumed['status']=='queued')
# This loop observes only; all stage advancement belongs to background server.
for _ in range(30):
    code,final,_=request('GET',detail,token=a)
    if final['status']=='completed':break
    time.sleep(.5)
check('server completes without browser handoffs',code==200 and final['status']=='completed')
check('six persisted checkpoints',len(final['stages'])==6 and all(s['status']=='completed' and s['checkpoint']['result_hash'] for s in final['stages']))
check('owner and source provenance retained',final['owner_id']==row['owner_id'] and final['inputs']['source_hash']==row['inputs']['source_hash'])
check('automatic order authority absent',final['inputs']['orders_authorized'] is False and final['inputs']['approvals_valid'] is False)
check('wrong-owner history excludes workflow',id not in {r['id'] for r in request('GET',path,token=b)[1]['items']})
check('direct financial route unavailable',request('POST','/zerodha/orders',{},a)[0] in {403,503})
result={'recorded_at':datetime.now(timezone.utc).isoformat(),'base':base,'passed':len(checks),'checks':checks,'workflow_id':id,'synthetic':True,'browser_handoffs_required':False,'live_systems_touched':False}
output=ROOT/'docs/public-launch/evidence/stage12-http-preview.json';output.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
