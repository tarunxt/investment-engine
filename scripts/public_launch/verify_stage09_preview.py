"""Real local API/BFF connection checks; loopback, synthetic accounts only."""
import json
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlsplit
import requests
root=Path(__file__).resolve().parents[2];runtime=root/'.runtime/stage01-preview';state=json.loads((runtime/'state.json').read_text());ui=f"http://localhost:{state['frontend_port']}";api=state['backend_url']
for value in (ui,api):
    parsed=urlsplit(value);assert parsed.scheme=='http' and parsed.hostname in {'localhost','127.0.0.1'} and parsed.port
checks=[];rows={};headers={}
def check(label,condition):
    assert condition,label
    checks.append(label)
for name,mode,ready in [('usera','user_owned',True),('userb','platform_managed',True),('admin','platform_managed',False)]:
    s=requests.Session();s.trust_env=False
    login=s.post(api+'/auth/login',json={'email':name+'@stage01.example.com','password':'SyntheticPreview123!'},timeout=10);login.raise_for_status();body=login.json();h={'Authorization':'Bearer '+body['access_token']};headers[name]=h
    r=s.get(api+'/me/connections',headers=h,timeout=10);check(name+' private API200/no-store',r.status_code==200 and r.headers.get('Cache-Control')=='no-store')
    data=r.json();row=data['connections'][0];rows[name]=row
    check(name+' own identity and mode',data['owner_id']==body['user']['id'] and len(data['connections'])==1 and row['app_ownership_mode']==mode)
    check(name+' readiness and no capabilities',row['readiness']['ready_for_adapter']==ready and not row['readiness']['module_access_granted'] and not row['readiness']['financial_execution_granted'])
    check(name+' secret-free DTO',not any(v in r.text for v in ['synthetic-token','synthetic-secret','synthetic-key','ciphertext','credential_ref']))
    csrf=s.get(ui+'/api/auth/csrf',timeout=10).json()['csrfToken'];r=s.post(ui+'/api/auth/callback/credentials',data={'csrfToken':csrf,'email':name+'@stage01.example.com','password':'SyntheticPreview123!','callbackUrl':ui+'/console/profile/connections','json':'true'},headers={'X-Auth-Return-Redirect':'1'},timeout=10);r.raise_for_status()
    bff=s.get(ui+'/backend-api/me/connections',timeout=10);check(name+' real Auth.js/BFF metadata',bff.status_code==200 and bff.json()['owner_id']==data['owner_id'])
    page=s.get(ui+'/console/profile/connections',timeout=10);check(name+' actual Connections application HTML',page.status_code==200 and '/_next/' in page.text)
    csrf=s.get(ui+'/api/auth/csrf',timeout=10).json()['csrfToken'];s.post(ui+'/api/auth/signout',data={'csrfToken':csrf,'callbackUrl':ui+'/login'},headers={'X-Auth-Return-Redirect':'1'},timeout=10).raise_for_status()
    check(name+' logout BFF denial',s.get(ui+'/backend-api/me/connections',timeout=10).status_code==401)
s=requests.Session();s.trust_env=False
foreign=s.get(api+'/me/connections/'+rows['userb']['id'],headers=headers['usera'],timeout=10);missing=s.get(api+'/me/connections/missing',headers=headers['usera'],timeout=10)
check('foreign and missing metadata indistinguishable404',foreign.status_code==missing.status_code==404 and foreign.json()==missing.json())
check('admin cannot read foreign connection',s.get(api+'/me/connections/'+rows['usera']['id'],headers=headers['admin'],timeout=10).status_code==404)
check('anonymous metadata401',s.get(api+'/me/connections',timeout=10).status_code==401)
check('mutating setup remains unavailable',s.post(api+'/me/connections',headers=headers['usera'],json={},timeout=10).status_code==503)
check('real broker orders unavailable',s.post(api+'/zerodha/orders',headers=headers['usera'],json={},timeout=10).status_code==503)
report={'checked_at':datetime.now(timezone.utc).isoformat(),'stage':'09','ui':ui+'/console/profile/connections','api':api,'passed':len(checks),'checks':checks,'synthetic_only':True,'limitations':['SQLite not PostgreSQL migration/race proof','Fake provider approval is not external approval','No OAuth/real provider/email/orders/paidAI or UAT verification']}
(runtime/'stage09-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
