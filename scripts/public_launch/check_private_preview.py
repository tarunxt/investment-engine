"""Exercise actual localhost FastAPI + Next BFF using disposable synthetic sessions.

Never prints or retains tokens, cookies or sign-in responses. No provider calls.
"""
import json
from pathlib import Path
from urllib.parse import urlsplit
import requests

ROOT = Path(__file__).resolve().parents[2]


def main():
    state = json.loads((ROOT / '.runtime/stage01-preview/state.json').read_text())
    web = f"http://localhost:{state['frontend_port']}"
    api = state['backend_url']
    assert state['synthetic'] is True
    assert urlsplit(api).hostname == '127.0.0.1'
    assert urlsplit(api).port == state['backend_port']
    assert urlsplit(api).scheme == 'http'
    def client():
        s = requests.Session()
        s.trust_env = False
        return s
    public = client()
    assert public.get(api + '/jobs', timeout=10).status_code == 401
    assert public.get(web + '/backend-api/jobs', timeout=10).status_code == 401
    users = []
    for name in ('usera', 'userb'):
        credentials = {'email': f'{name}@stage01.example.com', 'password': 'SyntheticPreview123!'}
        direct, bff = client(), client()
        auth = direct.post(api + '/auth/login', json=credentials, timeout=10)
        assert auth.status_code == 200
        token = auth.json()['access_token']
        direct.headers['Authorization'] = 'Bearer ' + token
        csrf = bff.get(web + '/api/auth/csrf', timeout=10).json()['csrfToken']
        login = bff.post(web + '/api/auth/callback/credentials', data={
            **credentials, 'csrfToken': csrf, 'callbackUrl': web + '/console/jobs',
        }, allow_redirects=False, timeout=15)
        assert login.status_code in {200, 302, 303}
        results = []
        for session, base in ((direct, api), (bff, web + '/backend-api')):
            r = session.get(base + '/jobs?limit=1&q=Stage02&user_id=999', timeout=10)
            assert r.status_code == 200
            data = r.json()
            assert data['total'] == 1 and len(data['items']) == 1
            assert name in data['items'][0]['prompt']
            page2 = session.get(base + '/jobs?limit=1&page=2', timeout=10).json()
            assert page2['total'] == 1 and page2['items'] == []
            results.append(data['items'][0]['id'])
            runs = session.get(base + '/runs?summary=true', timeout=10)
            assert runs.status_code == 200 and runs.json()['total'] == 1
        assert results[0] == results[1]
        users.append((direct, bff, token, results[0]))
    assert users[0][3] != users[1][3]
    for index, (direct, bff, _, _) in enumerate(users):
        foreign_id = users[1-index][3]
        for session, base in ((direct, api), (bff, web + '/backend-api')):
            rows = [session.get(f'{base}/jobs/{id}', timeout=10) for id in (foreign_id, 999999)]
            assert [r.status_code for r in rows] == [404, 404]
            assert rows[0].json() == rows[1].json()
        # Raw browser Authorization/owner input must not override the BFF session.
        spoofed = bff.get(web + '/backend-api/jobs', headers={
            'Authorization': 'Bearer ' + users[1-index][2], 'X-User-ID': '999',
        }, timeout=10)
        assert spoofed.status_code == 200 and spoofed.json()['items'][0]['id'] == users[index][3]
    report = {'frontend_url': web, 'backend_url': api,
              'checks': ['anonymous direct/BFF401', 'two synthetic credential sessions',
                         'per-owner list/search/count/pagination', 'owned run summaries',
                         'foreign/guessed IDs identical404 direct/BFF',
                         'spoofed Authorization/owner headers cannot override BFF session'],
              'result': 'passed', 'integrations': 'unavailable; no external actions',
              'tokens_or_cookies_retained': False}
    path = ROOT / '.runtime/stage01-preview/stage02-api-bff-verification.json'
    path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
