"""Offline source-extracted JWT tests: synthetic settings, no app/DB startup.

Run pytest --noconftest for these isolated tests. Consumer wiring is checked
separately below; this is not an API/DB/WebSocket integration suite.
"""
import ast
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Optional

import pytest
from jose import JWTError, jwt

ROOT = Path(__file__).parents[1]
KEY = "synthetic-purpose-test-key-only-" * 3


@pytest.fixture
def utils():
    source = ROOT / "app/core/security.py"
    tree = ast.parse(source.read_text())
    classes = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name in ("JWTUtils", "AuthUtils")]
    namespace = dict(datetime=datetime, timedelta=timedelta, Optional=Optional,
                     Dict=Dict, Any=Any, jwt=jwt, JWTError=JWTError,
                     settings=SimpleNamespace(jwt_signing_key=SimpleNamespace(get_secret_value=lambda: KEY)),
                     ALGORITHM="HS256", ACCESS_TOKEN_EXPIRE_MINUTES=15, REFRESH_TOKEN_EXPIRE_DAYS=7)
    exec(compile(ast.Module(body=classes, type_ignores=[]), str(source), "exec"), namespace)
    return namespace["JWTUtils"], namespace["AuthUtils"]


def signed(**claims):
    return jwt.encode(claims, KEY, algorithm="HS256")


def test_existing_pair_shapes_claims_and_lifetimes_unchanged(utils):
    verifier, issuer = utils
    pair = issuer.create_tokens(42, "fixture@example.invalid", "user")
    access = verifier.verify_access_token(pair["access_token"])
    refresh = verifier.verify_refresh_token(pair["refresh_token"])
    assert set(access) == {"sub", "email", "role", "exp", "iat"}
    assert set(refresh) == {"sub", "email", "type", "exp", "iat"}
    assert access["sub"] == refresh["sub"] == "42"
    assert access["email"] == refresh["email"] == "fixture@example.invalid"
    assert access["role"] == "user" and refresh["type"] == "refresh"
    assert access["exp"] - access["iat"] == 900
    assert refresh["exp"] - refresh["iat"] == 7 * 24 * 3600
    assert verifier.verify_refresh_token(pair["access_token"]) is None
    assert verifier.verify_access_token(pair["refresh_token"]) is None


@pytest.mark.parametrize("token_type", [None, "access", "reset", "", 1, [], {}])
def test_explicit_non_refresh_types_are_not_existing_access_shape(utils, token_type):
    verifier, _ = utils
    token = signed(sub="42", type=token_type, exp=datetime.utcnow() + timedelta(minutes=1))
    assert verifier.verify_access_token(token) is None
    assert verifier.verify_refresh_token(token) is None


@pytest.mark.parametrize("purpose", ["access", "refresh"])
@pytest.mark.parametrize("expiry", ["missing", None, "invalid", [], {}, float("inf"), -1])
def test_missing_malformed_and_expired_expiry_denied(utils, purpose, expiry):
    verifier, _ = utils
    claims = {"sub": "42"}
    if purpose == "refresh":
        claims["type"] = "refresh"
    if expiry != "missing":
        claims["exp"] = expiry
    token = signed(**claims)
    assert getattr(verifier, f"verify_{purpose}_token")(token) is None


@pytest.mark.parametrize("purpose", ["access", "refresh"])
def test_malformed_signature_algorithm_and_expired_tokens_denied(utils, purpose):
    verifier, _ = utils
    verify = getattr(verifier, f"verify_{purpose}_token")
    claims = {"sub": "42", "exp": datetime.utcnow() + timedelta(minutes=1)}
    if purpose == "refresh":
        claims["type"] = "refresh"
    assert verify("malformed.fixture.token") is None
    assert verify(jwt.encode(claims, "different-synthetic-key", algorithm="HS256")) is None
    assert verify(jwt.encode(claims, KEY, algorithm="HS384")) is None
    claims["exp"] = datetime.utcnow() - timedelta(minutes=1)
    assert verify(signed(**claims)) is None


def test_custom_access_lifetime_preserved(utils):
    verifier, _ = utils
    token = verifier.create_access_token(42, "fixture@example.invalid", "user", timedelta(seconds=120))
    payload = verifier.verify_access_token(token)
    assert payload["exp"] - payload["iat"] == 120


@pytest.mark.parametrize("path,method", [
    ("app/domains/auth/dependencies.py", "verify_access_token"),
    ("app/shared/ws_relay.py", "verify_access_token"),
    ("app/domains/polymarket_auto_live/router.py", "verify_access_token"),
    ("app/domains/auth/router.py", "verify_refresh_token"),
])
def test_each_existing_consumer_uses_intended_verifier(path, method):
    tree = ast.parse((ROOT / path).read_text())
    calls = [n.func.attr for n in ast.walk(tree) if isinstance(n, ast.Call)
             and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name)
             and n.func.value.id == "JWTUtils"]
    assert method in calls
    assert "verify_token" not in calls
    assert "decode_token" not in calls


def extracted_function(path, name, namespace):
    """Execute the actual function body with explicit synthetic boundary doubles."""
    tree = ast.parse((ROOT / path).read_text())
    function = next(n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)
    function.decorator_list = []
    function.returns = None
    function.args.defaults = []
    for arg in function.args.args:
        arg.annotation = None
    exec(compile(ast.Module(body=[function], type_ignores=[]), path, "exec"), namespace)
    return namespace[name]


class Denied(Exception):
    def __init__(self, status_code, detail=None, **kwargs):
        self.status_code = status_code


class Query:
    def where(self, *_):
        return self

    def options(self, *_):
        return self


class Column:
    def __eq__(self, other):
        return True


@pytest.mark.parametrize("consumer", ["dependency", "refresh", "websocket", "persisted"])
@pytest.mark.parametrize("credential", ["intended", "wrong-purpose", "expired", "missing-expiry", "malformed"])
def test_consumer_bodies_with_synthetic_database(utils, consumer, credential):
    import asyncio
    from time import monotonic

    verifier, issuer = utils
    pair = issuer.create_tokens(42, "fixture@example.invalid", "user")
    refresh_consumer = consumer == "refresh"
    token = pair["refresh_token" if refresh_consumer else "access_token"]
    if credential == "wrong-purpose":
        token = pair["access_token" if refresh_consumer else "refresh_token"]
    elif credential in ("expired", "missing-expiry"):
        claims = {"sub": "42"}
        if refresh_consumer:
            claims["type"] = "refresh"
        if credential == "expired":
            claims["exp"] = -1
        token = signed(**claims)
    elif credential == "malformed":
        token = "malformed.fixture.token"

    user = SimpleNamespace(id=42, is_active=True, email="fixture@example.invalid", role=SimpleNamespace(value="user"))
    class Database:
        calls = 0

        async def execute(self, query):
            self.calls += 1
            return SimpleNamespace(scalar_one_or_none=lambda: user, one_or_none=lambda: user)

    db = Database()
    namespace = dict(JWTUtils=verifier, AuthUtils=issuer, HTTPException=Denied,
                     status=SimpleNamespace(HTTP_401_UNAUTHORIZED=401, HTTP_403_FORBIDDEN=403),
                     monotonic=monotonic, add_auth_duration=lambda *_: None,
                     select=lambda *_: Query(), selectinload=lambda *_: None,
                     User=SimpleNamespace(id=Column(), is_active=Column(), profile=None),
                     is_auth_disabled=lambda: False,
                     UserResponse=SimpleNamespace(model_validate=lambda obj: obj),
                     LoginResponse=lambda **kwargs: SimpleNamespace(**kwargs))
    paths = {
        "dependency": ("app/domains/auth/dependencies.py", "get_current_user"),
        "refresh": ("app/domains/auth/router.py", "refresh_token"),
        "websocket": ("app/shared/ws_relay.py", "user_id_from_token"),
        "persisted": ("app/domains/polymarket_auto_live/router.py", "_resolve_persisted_status_user_id"),
    }
    function = extracted_function(*paths[consumer], namespace)
    if consumer == "websocket":
        assert function(token) == (42 if credential == "intended" else None)
        return
    request = SimpleNamespace(refresh_token=token) if refresh_consumer else SimpleNamespace(credentials=token)
    if credential != "intended":
        with pytest.raises(Denied) as error:
            asyncio.run(function(request, db))
        assert error.value.status_code == 401
        assert db.calls == 0
    else:
        result = asyncio.run(function(request, db))
        assert db.calls == 1
        if refresh_consumer:
            assert verifier.verify_access_token(result.access_token)["sub"] == "42"
            assert verifier.verify_refresh_token(result.refresh_token)["sub"] == "42"
        elif consumer == "persisted":
            assert result == 42
        else:
            assert result is user
