"""Restricted assembled HTTP runtime integration; no provider/network/DB calls."""
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock
sys.path[:0] = [str(Path(__file__).resolve().parents[3] / 'backend'),
               str(Path(__file__).resolve().parents[3] / 'ci/uat-real-engines/candidate')]
from fastapi.testclient import TestClient
from app.uat.owner_policy import OWNER_EMAIL, OwnerPolicy
from app.uat.sessions import OwnerSessions
from offline_stack.application import assemble
from offline_stack.barrier import SESSION_COOKIE

class ExportRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.user=SimpleNamespace(id=1,email=OWNER_EMAIL,is_active=True)
        self.claims=dict(sub='1',email=OWNER_EMAIL,type='access',iss='credx-uat',aud='credx-uat-api')
        self.verify=AsyncMock(return_value=self.claims)
        self.load=AsyncMock(return_value=self.user)
        self.resolve=AsyncMock();self.issue=AsyncMock()
        sessions=OwnerSessions(OwnerPolicy('uat',OWNER_EMAIL,'synthetic.apps.googleusercontent.com'),
                              AsyncMock(),self.resolve,self.verify,self.load,self.issue)
        self.origin='https://uat.example.test'
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        Path(self.tmp.name,'index.html').write_text('<html>synthetic fixture</html>')
        app=assemble(sessions=sessions,google_login=SimpleNamespace(origin=self.origin),
                     registry=SimpleNamespace(revoke=AsyncMock()),frontend_directory=self.tmp.name)
        self.client=TestClient(app,base_url=self.origin)
        self.headers={'Cookie':SESSION_COOKIE+'=synthetic-fixture','Origin':self.origin}
        self.payload={'rows':[{'symbol':'SYNTHETIC-INDEX','quantity':1}]}
    def post(self,**kwargs):
        return self.client.post('/simulation/exports',headers=self.headers,**kwargs)
    def test_authenticated_owner_uses_fixed_nondelivering_sink(self):
        result=self.post(json=self.payload)
        self.assertEqual(result.status_code,200)
        self.assertEqual(result.json(),dict(simulation=True,delivered=False,destination='memory-sink-v1',row_count=1,sink_sequence=1))
        self.resolve.assert_not_awaited();self.issue.assert_not_awaited()
        self.assertEqual(result.headers['cache-control'],'no-store')
        self.assertEqual(self.post(json=self.payload).json()['sink_sequence'],2)
    def test_anonymous_request_denied_before_session_lookup(self):
        self.assertEqual(self.client.post('/simulation/exports',headers={'Origin':self.origin},json=self.payload).status_code,401)
        self.verify.assert_not_awaited();self.load.assert_not_awaited()
    def test_nonowner_cross_environment_and_refresh_denied_before_profile_lookup(self):
        for key,value in [('email','nonowner@example.invalid'),('iss','production'),('aud','production'),('type','refresh')]:
            old=self.claims[key];self.claims[key]=value
            self.assertEqual(self.post(json=self.payload).status_code,401)
            self.claims[key]=old
        self.load.assert_not_awaited();self.resolve.assert_not_awaited();self.issue.assert_not_awaited()
    def test_disabled_owner_denied(self):
        self.user.is_active=False
        self.assertEqual(self.post(json=self.payload).status_code,401)
    def test_cross_origin_duplicate_origin_and_direct_bearer_denied(self):
        for headers in [dict(self.headers,Origin='https://evil.invalid'),
                        {'Cookie':self.headers['Cookie']},
                        dict(self.headers,Authorization='Bearer synthetic-fixture'),
                        [('Cookie',self.headers['Cookie']),('Origin',self.origin),('Origin',self.origin)]]:
            self.assertEqual(self.client.post('/simulation/exports',headers=headers,json=self.payload).status_code,401)
    def test_destinations_extra_fields_and_real_rows_rejected(self):
        for payload in [dict(self.payload,destination='https://example.invalid'),
                        dict(self.payload,path='/tmp/out'),
                        {'rows':[{'symbol':'REAL','quantity':1}]},
                        {'rows':[{'symbol':'SYNTHETIC-INDEX','quantity':True}]},
                        {'rows':[dict(self.payload['rows'][0],email='fixture@example.invalid')]},
                        {'rows':self.payload['rows']*101}]:
            with self.subTest(payload=payload):self.assertEqual(self.post(json=payload).status_code,422)
        self.assertEqual(self.post(json=self.payload).json()['sink_sequence'],1)
    def test_duplicate_json_and_oversized_body_rejected_without_sink_use(self):
        for body,status in [('not-json',422),('{"rows":[],"rows":[]}',422),
                            ('{"rows":[{"symbol":"SYNTHETIC-INDEX","quantity":1,"quantity":2}]}',422),(' '*16385,413)]:
            self.assertEqual(self.client.post('/simulation/exports',headers=dict(self.headers,**{'Content-Type':'application/json'}),content=body).status_code,status)
        self.assertEqual(self.post(json=self.payload).json()['sink_sequence'],1)
    def test_unregistered_real_export_routes_stay_unavailable(self):
        for path in ['/exports','/sheets/export','/simulation/exports/download','/broker/orders']:
            self.assertIn(self.client.post(path,headers=self.headers,json=self.payload).status_code,[404,405])
