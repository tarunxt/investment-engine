"""Only deterministic synthetic keys/tokens; no production credentials or I/O."""
import os
from pathlib import Path
import subprocess
import sys

import pytest
from jose import jwt
from pydantic import SecretStr, ValidationError

from app.core.config import Settings
from app.core import security

KEY = bytes(range(32)).hex()
OTHER_KEY = bytes(range(32, 64)).hex()
NAMES = ("JWT_SIGNING_KEY", "JWT_SECRET", "SECRET_KEY")


@pytest.fixture
def clean_env(monkeypatch):
    for name in NAMES:
        monkeypatch.delenv(name, raising=False)


def configured(**kwargs):
    return Settings(_env_file=None, database_url="postgresql://test", redis_url="redis://test", **kwargs)


@pytest.mark.parametrize("name", NAMES)
def test_each_environment_name_resolves_to_canonical(clean_env, monkeypatch, name):
    monkeypatch.setenv(name, KEY)
    settings = configured()
    assert settings.jwt_signing_key.get_secret_value() == KEY
    assert KEY not in repr(settings)
    assert KEY not in settings.model_dump_json()
    assert "jwt_signing_key" not in settings.model_dump()


def test_identical_aliases_accepted(clean_env, monkeypatch):
    for name in NAMES:
        monkeypatch.setenv(name, KEY)
    assert configured().jwt_signing_key.get_secret_value() == KEY


@pytest.mark.parametrize("other", ("JWT_SECRET", "SECRET_KEY"))
def test_conflicting_aliases_fail_closed(clean_env, monkeypatch, other):
    monkeypatch.setenv("JWT_SIGNING_KEY", KEY)
    monkeypatch.setenv(other, OTHER_KEY)
    with pytest.raises(ValidationError, match="Conflicting") as exc:
        configured()
    assert KEY not in str(exc.value)
    assert OTHER_KEY not in str(exc.value)


def test_legacy_aliases_also_must_agree(clean_env, monkeypatch):
    monkeypatch.setenv("JWT_SECRET", KEY)
    monkeypatch.setenv("SECRET_KEY", OTHER_KEY)
    with pytest.raises(ValidationError, match="Conflicting"):
        configured()


@pytest.mark.parametrize("value", ("", " ", "change-me", "your-secret-key", "default", "a" * 64,
                                    "deadbeef" * 8, "0123456789abcdef" * 4,
                                    KEY.upper(), KEY + " ", KEY[:-1], "g" * 64))
@pytest.mark.parametrize("name", NAMES)
def test_invalid_values_rejected_even_beside_valid_canonical(clean_env, monkeypatch, value, name):
    monkeypatch.setenv("JWT_SIGNING_KEY", KEY)
    monkeypatch.setenv(name, value)
    with pytest.raises(ValidationError):
        configured()


def test_missing_key_rejected_even_when_auth_disabled(clean_env):
    with pytest.raises(ValidationError, match="JWT_SIGNING_KEY is required"):
        configured(auth_disabled=True, environment="development")


def test_dotenv_aliases_and_extra_runtime_fields(clean_env, tmp_path):
    env_file = tmp_path / "backend.env"
    env_file.write_text(f"JWT_SECRET={KEY}\nSECRET_KEY={KEY}\nUVICORN_WORKERS=2\nJWT_ALGORITHM=HS256\n")
    settings = Settings(_env_file=env_file, database_url="postgresql://test", redis_url="redis://test")
    assert settings.jwt_signing_key.get_secret_value() == KEY
    assert "UVICORN_WORKERS" not in settings.model_dump()


def test_process_env_overrides_same_dotenv_name_but_not_conflicting_alias(clean_env, monkeypatch, tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(f"JWT_SIGNING_KEY={OTHER_KEY}\n")
    monkeypatch.setenv("JWT_SIGNING_KEY", KEY)
    assert Settings(_env_file=env_file).jwt_signing_key.get_secret_value() == KEY
    env_file.write_text(f"JWT_SECRET={OTHER_KEY}\n")
    with pytest.raises(ValidationError, match="Conflicting"):
        Settings(_env_file=env_file)


def test_constructor_and_case_insensitive_environment_compatibility(clean_env, monkeypatch):
    assert configured(jwt_signing_key=KEY).jwt_signing_key.get_secret_value() == KEY
    monkeypatch.setenv("jwt_secret", KEY)
    assert configured().jwt_signing_key.get_secret_value() == KEY


@pytest.mark.parametrize("entry", ("app.main", "app.core.security", "app.core.config"))
@pytest.mark.parametrize("value", (None, "", "change-me"))
def test_startup_import_fails_before_serving_without_valid_key(tmp_path, entry, value):
    env = {"PATH": os.environ.get("PATH", ""), "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
           "DATABASE_URL": "postgresql://test", "REDIS_URL": "redis://test"}
    if value is not None:
        env["JWT_SIGNING_KEY"] = value
    result = subprocess.run([sys.executable, "-c", f"import {entry}"], cwd=tmp_path,
                            env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode != 0
    assert "JWT" in result.stderr
    assert "ValidationError" in result.stderr
    if value:
        assert value not in result.stderr


def test_valid_config_allows_auth_startup_import(tmp_path):
    env = {"PATH": os.environ.get("PATH", ""), "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
           "DATABASE_URL": "postgresql://test", "REDIS_URL": "redis://test", "JWT_SIGNING_KEY": KEY}
    result = subprocess.run([sys.executable, "-c", "from app.core.security import JWTUtils"],
                            cwd=tmp_path, env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert KEY not in result.stdout + result.stderr


def test_sign_verify_rotation_and_existing_token_contract(monkeypatch):
    monkeypatch.setattr(security.settings, "jwt_signing_key", SecretStr(KEY))
    tokens = security.AuthUtils.create_tokens(7, "fixture@example.invalid", "user")
    access = security.JWTUtils.verify_token(tokens["access_token"])
    refresh = security.JWTUtils.verify_token(tokens["refresh_token"])
    assert tokens["token_type"] == "bearer"
    assert access["sub"] == refresh["sub"] == "7"
    assert access["email"] == refresh["email"] == "fixture@example.invalid"
    assert access["role"] == "user" and "type" not in access
    assert refresh["type"] == "refresh" and "role" not in refresh
    assert access["exp"] - access["iat"] == 15 * 60
    assert refresh["exp"] - refresh["iat"] == 7 * 24 * 60 * 60
    assert jwt.get_unverified_header(tokens["access_token"])["alg"] == "HS256"
    for token in (tokens["access_token"], tokens["refresh_token"]):
        assert jwt.decode(token, KEY, algorithms=["HS256"])["sub"] == "7"
    # Synthetic old key simulates rotation, without minting with any real or
    # historical production signing key. No previous-key fallback is allowed.
    monkeypatch.setattr(security.settings, "jwt_signing_key", SecretStr(OTHER_KEY))
    assert security.JWTUtils.verify_token(tokens["access_token"]) is None
    assert security.JWTUtils.verify_token(tokens["refresh_token"]) is None
    new_token = security.JWTUtils.create_access_token(7, "fixture@example.invalid", "user")
    assert security.JWTUtils.verify_token(new_token)["sub"] == "7"
    wrong_algorithm = jwt.encode({"sub": "7"}, OTHER_KEY, algorithm="HS384")
    assert security.JWTUtils.verify_token(wrong_algorithm) is None
    assert security.JWTUtils.verify_token("malformed.fixture.token") is None


@pytest.mark.anyio
async def test_rotated_tokens_rejected_by_dependency_and_refresh_before_database(monkeypatch):
    from fastapi import HTTPException
    from fastapi.security import HTTPAuthorizationCredentials
    from app.domains.auth.dependencies import get_current_user
    from app.domains.auth.router import refresh_token
    from app.domains.auth.schemas import RefreshTokenRequest

    monkeypatch.setattr(security.settings, "jwt_signing_key", SecretStr(KEY))
    tokens = security.AuthUtils.create_tokens(7, "fixture@example.invalid", "user")
    monkeypatch.setattr(security.settings, "jwt_signing_key", SecretStr(OTHER_KEY))
    # An object without execute() proves rejection happens before DB lookup.
    with pytest.raises(HTTPException) as access_error:
        await get_current_user(HTTPAuthorizationCredentials(scheme="Bearer", credentials=tokens["access_token"]), object())
    assert access_error.value.status_code == 401
    with pytest.raises(HTTPException) as refresh_error:
        await refresh_token(RefreshTokenRequest(refresh_token=tokens["refresh_token"]), object())
    assert refresh_error.value.status_code == 401


def test_custom_access_expiration_and_expired_token_rejection(monkeypatch):
    from datetime import timedelta
    monkeypatch.setattr(security.settings, "jwt_signing_key", SecretStr(KEY))
    token = security.JWTUtils.create_access_token(7, "fixture@example.invalid", "user", timedelta(seconds=120))
    payload = security.JWTUtils.verify_token(token)
    assert payload["exp"] - payload["iat"] == 120
    expired = security.JWTUtils.create_access_token(7, "fixture@example.invalid", "user", timedelta(seconds=-5))
    assert security.JWTUtils.verify_token(expired) is None
