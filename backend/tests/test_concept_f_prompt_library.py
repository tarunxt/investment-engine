"""Actual native route/auth with synthetic SQL; no providers, startup or external stores."""
from fastapi.testclient import TestClient
from sqlalchemy import select,func
from app.uat2.main import app
from app.infrastructure.database.session import get_async_db
from app.domains.prompts.models import Prompt
from app.domains.auth.models import UserRole
from test_private_api_ownership import private_api

def test_native_prompt_library_scope_system_integrity_and_read_only_contract(private_api):
    a=private_api
    rows=[Prompt(user_id=None,is_system=True,name='shared',body='system inert template'),
          Prompt(user_id=a.users[0].id,is_system=False,name='owned a',body='owned a only'),
          Prompt(user_id=a.users[1].id,is_system=False,name='owned b',body='foreign b only'),
          Prompt(user_id=a.users[1].id,is_system=True,name='inconsistent',body='foreign corrupt system')]
    a.session.add_all(rows);a.session.commit()
    before=a.session.scalar(select(func.count()).select_from(Prompt))
    assert app.dependency_overrides=={}
    app.dependency_overrides[get_async_db]=a.app.dependency_overrides[get_async_db]
    try:
        client=TestClient(app,raise_server_exceptions=True);path='/uat2/simulation/prompt-library'
        try:
            assert client.get(path).status_code==401
            assert client.get(path,headers=a.headers[2]).status_code==403
            for owner in (0,1):
                response=client.get(path,headers=a.headers[owner]);assert response.status_code==200,response.text
                data=response.json();assert data['owner_id']==a.users[owner].id
                assert data['read_only'] and data['simulation_only'] and data['governed_prompt_override_available'] is False
                assert {row['id'] for row in data['items']}=={rows[0].id,rows[owner+1].id}
                assert response.headers['cache-control']=='private, no-store'
                assert client.get(path+'/'+str(rows[2-owner].id),headers=a.headers[owner]).status_code==404
                assert client.get(path+'/'+str(rows[3].id),headers=a.headers[owner]).status_code==404
                assert client.get(path+'/'+str(rows[owner+1].id),headers=a.headers[owner]).json()['item']['body']==rows[owner+1].body
            a.users[0].role=UserRole.ADMIN;a.session.commit()
            assert client.get(path+'/'+str(rows[2].id),headers=a.headers[0]).status_code==404
            response=client.get(path,params={'limit':1},headers=a.headers[0]);assert len(response.json()['items'])==1 and response.json()['has_more']
            assert client.get(path,params={'q':'owned a'},headers=a.headers[0]).json()['items'][0]['id']==rows[1].id
            assert client.get(path,params={'limit':101},headers=a.headers[0]).status_code==422
            assert client.post(path,json={'name':'unrequested'},headers=a.headers[0]).status_code==503
            assert a.session.scalar(select(func.count()).select_from(Prompt))==before
        finally:client.close()
    finally:app.dependency_overrides.clear()
