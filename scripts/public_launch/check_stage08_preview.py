"""Real Auth.js/BFF/FastAPI/SQL Stage08 synthetic combinations and failures."""
import json,time
from pathlib import Path
from urllib.parse import urlsplit
import requests
ROOT=Path(__file__).resolve().parents[2]

def main():
 state=json.loads((ROOT/'.runtime/stage01-preview/state.json').read_text());assert state['synthetic'] and urlsplit(state['backend_url']).hostname=='127.0.0.1'
 web=f"http://localhost:{state['frontend_port']}";checks=[];sessions={};fault=ROOT/'.runtime/stage01-preview/faults.json'
 def req(session,name,method,path,status=200,**kwargs):
  response=session.request(method,web+'/backend-api'+path,timeout=15,**kwargs);assert response.status_code in (status if isinstance(status,tuple) else (status,)),(name,response.status_code,response.text[:180]);checks.append({'check':name,'status':status});return response
 for name in ('usera','userb'):
  s=requests.Session();s.trust_env=False;csrf=s.get(web+'/api/auth/csrf',timeout=10).json()['csrfToken'];r=s.post(web+'/api/auth/callback/credentials',data={'email':name+'@stage01.example.com','password':'SyntheticPreview123!','csrfToken':csrf,'callbackUrl':web+'/console/profile/preferences'},allow_redirects=False,timeout=10);assert r.status_code in (200,302,303);sessions[name]=s
 a,b=sessions['usera'],sessions['userb'];cooldown=False
 def catalog(s):return req(s,'Fresh owned manifest','GET','/me/modules').json()
 def select(s,ids):
  prior=catalog(s);return req(s,'Atomic selection '+','.join(ids),'PATCH','/me/modules',json={'expected_version':prior['version'],'updates':[{'module_id':m['module_id'],'enabled':m['module_id'] in ids} for m in prior['modules'] if m['selection']['enabled']!=(m['module_id'] in ids)]}).json() if any(m['selection']['enabled']!=(m['module_id'] in ids) for m in prior['modules']) else prior
 jobs_before={name:req(s,'Owned core history count','GET','/jobs').json()['total'] for name,s in sessions.items()}
 try:
  for s in (a,b):select(s,[])
  empty=catalog(a);assert empty['presentation']['schema_version']==1 and len(empty['modules'])==10
  req(a,'Default-off India data denied','GET','/zerodha/portfolio',403)
  india=select(a,['zerodha_rebalance']);req(a,'India-only synthetic data','GET','/zerodha/portfolio');req(a,'India-only excludes US data','GET','/indmoney-us/portfolio',403)
  req(b,'B has no inherited India selection','GET','/zerodha/portfolio',403)
  req(a,'Stale tab CAS conflict','PATCH','/me/modules',409,json={'expected_version':india['version']-1,'updates':[{'module_id':'indmoney_us','enabled':True}]})
  select(a,['indmoney_us']);req(a,'US-only excludes India data','GET','/zerodha/portfolio',403);own=req(a,'US-only real owned snapshot read','GET','/indmoney-us/portfolio').json();snapshot=own['latest']['id']
  select(b,['indmoney_us']);other=req(b,'B own US snapshot','GET','/indmoney-us/portfolio').json();assert other['latest']['id']!=snapshot
  req(b,'Foreign US snapshot indistinguishable missing','GET',f'/indmoney-us/portfolio/{snapshot}',404)
  combined=select(a,['zerodha_rebalance','indmoney_us']);req(a,'Combined India data','GET','/zerodha/portfolio');req(a,'Combined US data','GET','/indmoney-us/portfolio')
  assert all(m['selection']['schedules_paused'] for m in combined['modules']) and not any(m['execution']['action_confirmed'] for m in combined['modules'])
  req(a,'Unavailable Bullpen cannot be enabled','PATCH','/me/modules',409,json={'expected_version':combined['version'],'updates':[{'module_id':'bullpen_live','enabled':True}]})
  req(a,'No module selection authorizes real order','POST','/zerodha/orders',503,json={'tradingsymbol':'SYNTHETIC','quantity':1})
  req(a,'Core safety activity remains available','GET','/me/modules/safety-activity')
  fault.write_text(json.dumps({'mode':'fail'}));req(a,'Real policy API outage','GET','/me/modules',503);fault.unlink()
  fault.write_text(json.dumps({'mode':'slow','seconds':.3}));start=time.monotonic();catalog(a);assert time.monotonic()-start>=.3;fault.unlink()
  for name,s in sessions.items():assert req(s,'Selection starts no jobs','GET','/jobs').json()['total']==jobs_before[name]
  select(a,[]);assert req(a,'None ordinary history projection empty','GET','/jobs?selected_only=true').json()['total']==0
  fault.write_text(json.dumps({'mode':'slow','seconds':2}));cooldown=True;req(a,'Slow policy exceeds existing bounded BFF deadline','GET','/me/modules',(502,504));fault.unlink()
 finally:
  fault.unlink(missing_ok=True)
  if cooldown:time.sleep(31)  # Honor the existing circuit cooldown; never raise its budget.
  for s in sessions.values():select(s,[])
 report={'result':'passed','count':len(checks),'checks':checks,'frontend_url':web,'backend_url':state['backend_url'],'tokens_or_cookies_retained':False,'limits':'Real app Auth.js/BFF/FastAPI/SQL; explicit local synthetic facts/adapters and isolated SQLite. No live UAT, provider/order/email/paidAI or real Google identity claim.'};(ROOT/'.runtime/stage01-preview/stage08-functional.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='checks'},indent=2))
if __name__=='__main__':main()
