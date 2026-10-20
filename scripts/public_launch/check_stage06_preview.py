"""Real Next/Auth.js/BFF module preferences; isolated synthetic accounts only."""
import json
from pathlib import Path
from urllib.parse import urlsplit
import requests
ROOT=Path(__file__).resolve().parents[2]

def main():
    state=json.loads((ROOT/'.runtime/stage01-preview/state.json').read_text())
    assert state['synthetic'] and urlsplit(state['backend_url']).hostname=='127.0.0.1'
    web=f"http://localhost:{state['frontend_port']}";api=state['backend_url'];checks=[]
    def check(label,response,status):
        assert response.status_code==status,(label,response.status_code,response.text[:150])
        checks.append({'check':label,'status':status});return response
    anon=requests.Session();anon.trust_env=False
    check('anonymous BFF module denial',anon.get(web+'/backend-api/me/modules',timeout=10),401)
    users={}
    for name in ('usera','userb'):
        direct,bff=requests.Session(),requests.Session();direct.trust_env=bff.trust_env=False
        credentials={'email':name+'@stage01.example.com','password':'SyntheticPreview123!'}
        auth=check(name+' login',direct.post(api+'/auth/login',json=credentials,timeout=10),200)
        direct.headers['Authorization']='Bearer '+auth.json()['access_token']
        csrf=bff.get(web+'/api/auth/csrf',timeout=10).json()['csrfToken']
        login=bff.post(web+'/api/auth/callback/credentials',data={**credentials,'csrfToken':csrf,'callbackUrl':web+'/console/profile'},allow_redirects=False,timeout=10)
        assert login.status_code in (200,302,303)
        initial=check(name+' authenticated BFF read',bff.get(web+'/backend-api/me/modules',timeout=10),200).json()
        assert len(initial['modules'])==10 and initial['operational_enforcement_complete'] is False
        users[name]=(bff,initial)
    a,initial=users['usera'];b,before_b=users['userb'];version=initial['version']
    prior=next(m['selection']['enabled'] for m in initial['modules'] if m['module_id']=='sports_rankings')
    body={'expected_version':version,'updates':[{'module_id':'sports_rankings','enabled':not prior}]}
    changed=check('atomic BFF patch',a.patch(web+'/backend-api/me/modules',json=body,timeout=10),200).json()
    assert changed['version']==version+1
    check('stale BFF patch',a.patch(web+'/backend-api/me/modules',json=body,timeout=10),409)
    unchanged=check('second owner isolation',b.get(web+'/backend-api/me/modules',timeout=10),200).json()
    assert unchanged==before_b
    impact=check('read-only disable impact',a.post(web+'/backend-api/me/modules/disable-impact',json={'expected_version':changed['version'],'module_ids':['sports_rankings']},timeout=10),200).json()
    assert impact['changes_applied'] is False and impact['data_and_connections_retained'] is True
    assert all(not c['allowed'] for m in changed['modules'] for c in m['capabilities'].values())
    check('owner override rejected',a.patch(web+'/backend-api/me/modules',json={**body,'owner_id':before_b['owner_id']},timeout=10),422)
    check('restore synthetic selection',a.patch(web+'/backend-api/me/modules',json={'expected_version':changed['version'],'updates':[{'module_id':'sports_rankings','enabled':prior}]},timeout=10),200)
    report={'result':'passed','count':len(checks),'checks':checks,'frontend_url':web,'backend_url':api,
        'tokens_cookies_retained':False,'scope':'Actual Next/Auth.js/BFF/FastAPI/SQL. Synthetic SQLite and offline adapters; no live provider, order, email, paid AI or UAT acceptance.'}
    (ROOT/'.runtime/stage01-preview/stage06-boundaries.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='checks'},indent=2))
if __name__=='__main__':main()
