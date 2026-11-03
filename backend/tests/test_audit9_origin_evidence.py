"""Synthetic ASGI fixtures from selected source functions, without app startup."""
import ast
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit
import unittest

from starlette.applications import Starlette
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

SOURCE = Path(__file__).resolve().parents[1] / 'app/main.py'


def controls(frontend='https://app.invalid', environment='production'):
    tree = ast.parse(SOURCE.read_text())
    names = {'_build_cors_allowed_origins', '_request_is_https', '_add_security_headers'}
    selected = [node for node in tree.body if
                isinstance(node, ast.FunctionDef) and node.name in names or
                isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in {'SECURITY_HEADERS', 'PRODUCTION_ENVIRONMENTS'} for t in node.targets)]
    namespace = {'settings': SimpleNamespace(frontend_url=frontend, environment=environment),
                 'getenv': lambda _: None, 'urlsplit': urlsplit, 'Request': object}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), 'exec'), namespace)
    middleware = next(node for node in ast.walk(tree) if isinstance(node, ast.Call)
                      and isinstance(node.func, ast.Attribute) and node.func.attr == 'add_middleware'
                      and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id == 'CORSMiddleware')
    options = {kw.arg: ast.literal_eval(kw.value) for kw in middleware.keywords if kw.arg != 'allow_origins'}
    options['allow_origins'] = namespace['_build_cors_allowed_origins']()
    return namespace, options


class OriginEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.namespace, options = controls()
        self.executions = []
        async def endpoint(request):
            self.executions.append(request.method)
            response = JSONResponse({'synthetic': True})
            self.namespace['_add_security_headers'](request, response)
            return response
        self.client = TestClient(CORSMiddleware(Starlette(routes=[Route('/fixture', endpoint, methods=['GET', 'POST'])]), **options), base_url='https://app.invalid')

    def test_configured_origins_and_apex_alias(self):
        self.assertEqual(self.namespace['_build_cors_allowed_origins'](),
                         ['http://127.0.0.1:3000', 'http://localhost:3000', 'https://app.invalid', 'https://www.app.invalid'])
        local, _ = controls('http://localhost:3000')
        self.assertNotIn('http://www.localhost:3000', local['_build_cors_allowed_origins']())

    def test_allowed_and_denied_preflight(self):
        for origin, expected in [('https://app.invalid', 200), ('https://www.app.invalid', 200), ('https://cross-site.invalid', 400), ('null', 400)]:
            with self.subTest(origin=origin):
                response = self.client.options('/fixture', headers={'origin': origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type'})
                self.assertEqual(response.status_code, expected)
                self.assertEqual(response.headers.get('access-control-allow-origin'), origin if expected == 200 else None)
        self.assertEqual(self.executions, [])

    def test_denied_simple_post_demonstrates_cors_is_not_csrf_enforcement(self):
        response = self.client.post('/fixture', headers={'origin': 'https://cross-site.invalid', 'content-type': 'application/x-www-form-urlencoded'}, content='synthetic=1')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.executions, ['POST'])
        self.assertNotIn('access-control-allow-origin', response.headers)

    def test_non_sensitive_response_headers_and_https_hsts(self):
        response = self.client.get('/fixture', headers={'origin': 'https://app.invalid'})
        for name, value in self.namespace['SECURITY_HEADERS'].items():
            self.assertEqual(response.headers[name], value)
        self.assertEqual(response.headers['strict-transport-security'], 'max-age=63072000; includeSubDomains; preload')
        self.assertEqual(response.headers['access-control-allow-origin'], 'https://app.invalid')
        self.assertEqual(response.headers['access-control-allow-credentials'], 'true')
        self.assertIn('ETag', response.headers['access-control-expose-headers'])

if __name__ == '__main__':
    unittest.main()
