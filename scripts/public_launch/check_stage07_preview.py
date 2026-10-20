"""Real local Auth.js/BFF lifecycle flows; synthetic no-egress harness only."""
import json,time
from datetime import datetime,timedelta,timezone
from pathlib import Path
from urllib.parse import urlsplit
import requests
ROOT=Path(__file__).resolve().parents[2]

def main():
    state=json.loads((ROOT/'.runtime/stage01-preview/state.json').read_text());assert state['synthetic'] and urlsplit(state['backend_url']).hostname=='127.0.0.1'
    web=f"http://localhost:{state['frontend_port']}";checks=[];sessions={}
    def request(session,label,method,path,status=200,**kwargs):
        response=session.request(method,web+'/backend-api'+path,timeout=10,**kwargs)
        assert response.status_code==status,(label,response.status_code,response.text[:160]);checks.append({'check':label,'status':status});return response
    for name in ['usera','userb']:
        s=requests.Session();s.trust_env=False
        csrf=s.get(web+'/api/auth/csrf',timeout=10).json()['csrfToken']
        r=s.post(web+'/api/auth/callback/credentials',data={'email':name+'@stage01.example.com','password':'SyntheticPreview123!','csrfToken':csrf,'callbackUrl':web+'/console/profile'},allow_redirects=False,timeout=10)
        assert r.status_code in (200,302,303);sessions[name]=s
        request(s,name+' identity','GET','/auth/me')
    a,b=sessions['usera'],sessions['userb'];before_b=request(b,'B initial state','GET','/me/modules').json()
    def get():return request(a,'A current catalogue','GET','/me/modules').json()
    def select(enabled):
        prior=get();return request(a,'A select '+str(enabled),'PATCH','/me/modules',json={'expected_version':prior['version'],'updates':[{'module_id':'ai_studio','enabled':enabled}]}).json()
    initial=get();prior=next(m['selection']['enabled'] for m in initial['modules'] if m['module_id']=='ai_studio')
    if prior:select(False)
    body={'prompt':'Synthetic Stage07 controlled work','provider':'synthetic','model':'offline'}
    request(a,'Disabled UI-bypass creation denied','POST','/jobs',403,json=body)
    enabled=select(True)
    request(a,'Stale tab cannot disable','PATCH','/me/modules',409,json={'expected_version':enabled['version']-1,'updates':[{'module_id':'ai_studio','enabled':False}]})
    request(a,'Explicit analysis schedule resume','POST','/me/modules/ai_studio/resume-schedules',json={'expected_version':enabled['version']})
    scheduled=request(a,'Create future synthetic analysis','POST','/jobs',json={**body,'scheduled_at':(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat()}).json()
    impact=request(a,'Real disable-impact counts','POST','/me/modules/disable-impact',json={'expected_version':enabled['version'],'module_ids':['ai_studio']}).json()
    assert impact['active_work']['analysis_inspected'] is True and impact['active_work']['queued_analysis']>=1 and not impact['changes_applied']
    select(False)
    stopped=request(a,'Queued analysis cancelled','GET',f"/jobs/{scheduled['id']}").json();assert stopped['status']=='failed'
    enabled=select(True)
    new=get();assert next(m for m in new['modules'] if m['module_id']=='ai_studio')['selection']['schedules_paused']
    request(a,'Re-enable does not resume schedules','POST','/jobs',409,json={**body,'scheduled_at':(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat()})
    running=request(a,'Create immediate fake analysis','POST','/jobs',json={**body,'prompt':'Synthetic Stage07 running cancellation'}).json()
    for _ in range(30):
        row=request(a,'Poll fake running phase','GET',f"/jobs/{running['id']}").json()
        if row['status']=='processing':break
        assert row['status'] in {'pending','scheduled'};time.sleep(.1)
    else:raise AssertionError('Fake consumer did not reach running phase')
    select(False)
    for _ in range(30):
        row=request(a,'Observe cooperative stop','GET',f"/jobs/{running['id']}").json()
        if row['status']=='failed':break
        time.sleep(.1)
    else:raise AssertionError('Running fake work did not cooperatively stop')
    select(True)
    assert request(a,'Old running work stays stopped','GET',f"/jobs/{running['id']}").json()['status']=='failed'
    request(b,'Foreign synthetic work hidden','GET',f"/jobs/{running['id']}",404)
    after_b=request(b,'B policy unchanged','GET','/me/modules').json();assert before_b==after_b
    request(a,'Existing Preferences retained','GET','/auth/profile')
    select(prior)
    report={'result':'passed','count':len(checks),'checks':checks,'frontend_url':web,'backend_url':state['backend_url'],'synthetic_job_ids':[scheduled['id'],running['id']],'tokens_cookies_retained':False,'limitations':'Real Next/Auth.js/BFF/FastAPI/SQL with explicit synthetic AI facts, offline fake consumer and SQLite. No real provider/order/email/paidAI. PostgreSQL concurrency and live UAT acceptance are separate.'}
    (ROOT/'.runtime/stage01-preview/stage07-lifecycle.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='checks'},indent=2))
if __name__=='__main__':main()
