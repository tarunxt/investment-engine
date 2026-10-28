"""Real HTTP admission, disposable identities; no billing/provider calls."""
from types import SimpleNamespace
from fastapi import HTTPException
from test_private_api_ownership import private_api


def test_provider_summary_rejects_standard_user_before_configuration_or_fx(private_api,monkeypatch):
    from importlib import import_module
    router=import_module('app.domains.api_usage.router')
    from app.domains.auth.models import UserRole
    a=private_api;a.app.include_router(router.router);calls=[]
    monkeypatch.setattr(router,'_google_sheets_service',SimpleNamespace(is_configured=False))
    async def admitted():calls.append('admitted');raise HTTPException(418,'Synthetic admitted boundary')
    monkeypatch.setattr(router,'load_persisted_usd_inr_rate',admitted)
    assert a.client.get('/api-usage/summary').status_code==401
    for header in a.headers:
        assert a.client.get('/api-usage/summary',headers=header).status_code==403
    assert calls==[]
    a.users[0].role=UserRole.ADMIN;a.session.commit()
    assert a.client.get('/api-usage/summary',headers=a.headers[0]).status_code==418
    assert calls==['admitted']


def test_cost_admission_preserves_narrow_existing_role_without_provider_access(private_api,monkeypatch):
    from app.domains.cost_drivers import router
    from app.domains.auth.admin_roles import AdministrativeRoleGrant
    from importlib import import_module
    usage=import_module('app.domains.api_usage.router')
    a=private_api
    AdministrativeRoleGrant.__table__.create(a.session.get_bind(),checkfirst=True)
    a.app.include_router(router.router);a.app.include_router(usage.router)
    monkeypatch.setattr(router,'get_dashboard',lambda *a,**k:(_ for _ in ()).throw(AssertionError('No billing fetch')))
    assert a.client.get('/api/admin/cost-drivers/access',headers=a.headers[0]).status_code==403
    a.session.add(AdministrativeRoleGrant(user_id=a.users[1].id,role='cost_dashboard_admin',source='synthetic fixture'))
    a.session.commit()
    response=a.client.get('/api/admin/cost-drivers/access',headers=a.headers[1])
    assert response.status_code==200 and response.json()['owner_id']==a.users[1].id
    assert a.client.get('/api-usage/summary',headers=a.headers[1]).status_code==403
