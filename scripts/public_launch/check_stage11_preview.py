"""Exercise real import handlers in the guarded loopback-only synthetic preview."""
import json,hashlib,urllib.request,urllib.error
from pathlib import Path
from datetime import datetime,timezone,timedelta
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

def check(name,condition):
    assert condition,name;checks.append(name)

health=request('GET','/preview-health');check('guarded synthetic no-egress preview',health[0]==200 and health[1]['outbound_network']=='denied')
def user(name):
    code,body,_=request('POST','/auth/login',{'email':name+'@stage01.example.com','password':'SyntheticPreview123!'})
    assert code==200
    token=body['access_token'];code,modules,_=request('GET','/me/modules',token=token);assert code==200
    code,_,_=request('PATCH','/me/modules',{'expected_version':modules['version'],'updates':[{'module_id':'indmoney_us','enabled':True}]},token)
    assert code==200
    return token
# Runtime-only dummy fixture tokens are never printed or saved.
a=user('usera');b=user('userb')
from app.domains.indmoney_us.import_validation import CSV_TEMPLATE
now=datetime.now(timezone.utc)
body={'raw_text':CSV_TEMPLATE,'captured_at':now.isoformat(),'format':'csv','currency':'USD'}
check('anonymous preview blocked',request('POST','/indmoney-us/imports/preview',body)[0]==401)
code,preview,cache=request('POST','/indmoney-us/imports/preview',body,a)
check('actual immutable preview requires separate acceptance',code==200 and preview['acceptance_state']=='preview')
check('private no-store response',cache=='private, no-store')
check('UTC timezone retained',preview['captured_at'].endswith('Z') or preview['captured_at'].endswith('+00:00'))
code,duplicate,_=request('POST','/indmoney-us/imports/preview',body,a);check('duplicate preview reuses reference',code==200 and duplicate['id']==preview['id'])
path=f"/indmoney-us/imports/{preview['id']}/accept";accept={'accept':True,'content_hash':preview['content_hash']}
check('foreign owner acceptance blocked',request('POST',path,accept,b)[0]==404)
check('wrong content hash rejected',request('POST',path,{**accept,'content_hash':'0'*64},a)[0]==409)
check('legacy direct-save bypass blocked',request('POST','/indmoney-us/portfolio',body,a)[0]==503)
code,accepted,_=request('POST',path,accept,a);check('explicit exact acceptance persisted',code==200 and accepted['acceptance_state']=='accepted')
code,overview,_=request('GET','/indmoney-us/portfolio',token=a);check('accepted reference becomes current',code==200 and overview['latest']['id']==accepted['id'])
check('foreign detail blocked',request('GET',f"/indmoney-us/portfolio/{accepted['id']}",token=b)[0]==404)
bad={**body,'raw_text':CSV_TEMPLATE.replace('Synthetic Alpha','Reports')}
code,quarantine,_=request('POST','/indmoney-us/imports/preview',bad,a);check('Reports mapping quarantined',code==200 and quarantine['acceptance_state']=='quarantined')
check('quarantined acceptance rejected',request('POST',f"/indmoney-us/imports/{quarantine['id']}/accept",{'accept':True,'content_hash':quarantine['content_hash']},a)[0]==422)
check('quarantine never replaces accepted current',request('GET','/indmoney-us/portfolio',token=a)[1]['latest']['id']==accepted['id'])
corrected={**body,'raw_text':CSV_TEMPLATE.replace(',2,55,100,110,10,10',',2,60,100,120,20,20'),'captured_at':(now-timedelta(minutes=1)).isoformat(),'supersedes_id':accepted['id']}
code,correction,_=request('POST','/indmoney-us/imports/preview',corrected,a);assert code==200
code,new,_=request('POST',f"/indmoney-us/imports/{correction['id']}/accept",{'accept':True,'content_hash':correction['content_hash']},a)
check('earlier-asof accepted correction becomes current',code==200 and request('GET','/indmoney-us/portfolio',token=a)[1]['latest']['id']==new['id'])
check('prior immutable snapshot retained',request('GET',f"/indmoney-us/portfolio/{accepted['id']}",token=a)[1]['holdings'][0]['current_value']==110)
check('provider price endpoint stays unmounted',request('POST','/indmoney-us/prices/current',{'quotes':[{'exchange':'NASDAQ','symbol':'UATA'}]},a)[0]==503)
check('current parser4 acceptance receipt',accepted['parser_current'] is True and accepted['import_provenance']['parser_version']=='indmoney-manual-4')
header=CSV_TEMPLATE.splitlines()[0]+'\n'
review_cases=[('tiny_opposite_sign',header+'UATA,Synthetic Alpha,USD,1,99.99,100,99.99,-0.01,0.01\n','csv'),
 ('unrepresentable_cent',header+'UATA,Synthetic Alpha,USD,1,,1000000000000000,1000000000000000,0,0\nUATB,Synthetic Beta,USD,1,,0.01,0.01,0,0\n','csv'),
 ('oversized_paste','Current Value\n$'+'9'*400+'\nInvested Value\n$100\nCurrent Holdings (1)\nSynthetic Alpha\nUATA\n$55\n$100\n2 Qty\n$50 Avg.\n$110\n+$10\n+10%','paste')]
review_cases.extend([
 ('zero_pnl_loss',header+'UATA,Synthetic Alpha,USD,1,99.99,100,99.99,0,0.01\n','csv'),
 ('zero_pnl_gain',header+'UATA,Synthetic Alpha,USD,1,100.01,100,100.01,0,-0.01\n','csv'),
 ('unrepresentable_backfill','Current Value\n$90000000000000.02\nInvested Value\n$90000000000000.02\nCurrent Holdings (1)\nSynthetic Alpha\nUATA\n$1.0000000000000002\n$90000000000000.02\n90000000000000 Qty','paste')])
for name,raw,format in review_cases:
    code,rejected,_=request('POST','/indmoney-us/imports/preview',{**body,'raw_text':raw,'format':format},a)
    check(name+' JSON-safe quarantine and source hash',code==200 and rejected['acceptance_state']=='quarantined' and rejected['import_provenance']['source_hash']==hashlib.sha256(raw.encode()).hexdigest())
    check(name+' exact-hash acceptance denied',request('POST',f"/indmoney-us/imports/{rejected['id']}/accept",{'accept':True,'content_hash':rejected['content_hash']},a)[0]==422)
print(json.dumps({'checked_at':datetime.now(timezone.utc).isoformat(),'url':state['url'],'passed':len(checks),'failed':0,'checks':checks,'synthetic_only':True,'tokens_saved_or_printed':False,'live_systems_changed':False},indent=2))
