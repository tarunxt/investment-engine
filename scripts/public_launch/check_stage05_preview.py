"""Real localhost API and Auth.js/BFF checks; synthetic accounts only."""
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
import requests

ROOT=Path(__file__).resolve().parents[2]


def main():
    state=json.loads((ROOT/'.runtime/stage01-preview/state.json').read_text())
    assert state['synthetic'] and urlsplit(state['backend_url']).hostname=='127.0.0.1'
    web=f"http://localhost:{state['frontend_port']}";api=state['backend_url']
    results=[]
    def check(label,response,status):
        assert response.status_code==status,(label,response.status_code,response.text[:150])
        results.append({'check':label,'status':status})
    sessions={}
    for name in ('usera','userb','admin'):
        direct,bff=requests.Session(),requests.Session()
        direct.trust_env=bff.trust_env=False
        credentials={'email':name+'@stage01.example.com','password':'SyntheticPreview123!'}
        auth=direct.post(api+'/auth/login',json=credentials,timeout=10);check(name+' direct login',auth,200)
        direct.headers['Authorization']='Bearer '+auth.json()['access_token']
        csrf=bff.get(web+'/api/auth/csrf',timeout=10).json()['csrfToken']
        login=bff.post(web+'/api/auth/callback/credentials',data={**credentials,'csrfToken':csrf,'callbackUrl':web+'/console/profile'},allow_redirects=False,timeout=10)
        assert login.status_code in (200,302,303)
        check(name+' BFF identity',bff.get(web+'/backend-api/auth/me',timeout=10),200)
        sessions[name]=(direct,bff)
    paths=[]
    routes=list((ROOT/'frontend/app/api/bullpen-ai').rglob('route.ts'))+[ROOT/'frontend/app/api/universal-polymarket-scan/auto-run/route.ts']
    for route in routes:
        path='/api/'+str(route.parent.relative_to(ROOT/'frontend/app/api'))
        for method in re.findall(r'export async function (GET|POST)\(',route.read_text()):paths.append((method,path))
    assert len(paths)==13
    anonymous=requests.Session();anonymous.trust_env=False
    for method,path in paths:
        check('anonymous '+method+' '+path,anonymous.request(method,web+path,json={},timeout=10),401)
        for name in ('usera','userb'):
            check(name+' '+method+' '+path,sessions[name][1].request(method,web+path,json={},timeout=10),403)
    for name,(direct,bff) in sessions.items():
        status=200 if name=='admin' else 403
        for path in ('/polymarket/runtime/health','/polymarket/state','/polymarket/history','/api/admin/cost-drivers/traffic'):
            check(name+' direct '+path,direct.get(api+path,timeout=10),status)
        check(name+' frontend operator health',bff.get(web+'/api/bullpen-ai/health',timeout=10),status)
        check(name+' shared sports catalogue',direct.get(api+'/api/sports-rankings',timeout=10),200)
        check(name+' sports classify',direct.post(api+'/api/sports-rankings/classify',json={'sport_id':'cricket'},timeout=10),status)
    report={'result':'passed','frontend_url':web,'backend_url':api,'checks':results,
        'count':len(results),'tokens_cookies_credentials_retained':False,
        'scope':'Actual Next/Auth.js/BFF/FastAPI/SQL authentication; offline health/cost and empty sports fixtures. No runtime/provider/order was started. SQLite is not PostgreSQL parity or live UAT acceptance.'}
    (ROOT/'.runtime/stage01-preview/stage05-boundaries.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='checks'},indent=2))

if __name__=='__main__':main()
