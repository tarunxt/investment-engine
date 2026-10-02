"""JWT signing regressions. Every key here is a public, synthetic test fixture."""

from datetime import datetime, timedelta, timezone
import hashlib
import logging
import os
from pathlib import Path
import subprocess
import sys

from jose import jwt
import pytest
from pydantic import SecretStr, ValidationError

from app.core.config import Settings
from app.core import security


TEST_SIGNING_KEY = hashlib.sha256(b"jwt-signing-regression-fixture").hexdigest()
OTHER_SIGNING_KEY = hashlib.sha256(b"jwt-previous-key-regression-fixture").hexdigest()


def _settings(**overrides) -> Settings:
    return Settings(
        _env_file=None,
        database_url="postgresql://test",
        redis_url="redis://test",
        **overrides,
    )


@pytest.fixture(autouse=True)
def isolated_signing_configuration(monkeypatch):
    monkeypatch.setattr(security.settings, "jwt_secret_key", SecretStr(TEST_SIGNING_KEY))


def test_jwt_signing_key_is_required_even_when_legacy_aliases_exist(monkeypatch):
    for name in tuple(os.environ):
        if name.lower() == "jwt_secret_key":
            monkeypatch.delenv(name)
    monkeypatch.setenv("SECRET_KEY", OTHER_SIGNING_KEY)
    monkeypatch.setenv("JWT_SECRET", OTHER_SIGNING_KEY)

    with pytest.raises(ValidationError, match="jwt_secret_key") as captured:
        _settings()

    assert "Field required" in str(captured.value)
    assert OTHER_SIGNING_KEY not in str(captured.value)
    assert OTHER_SIGNING_KEY not in repr(captured.value)


@pytest.mark.parametrize(
    "invalid_key",
    [
        "",
        "short",
        "a" * 31,
        "a" * 64,
        "01" * 32,
        "0123456789abcdef" * 4,
        "not-a-hexadecimal-key" * 4,
        "replace-with-a-new-private-signing-key-before-deploying",
        TEST_SIGNING_KEY + "\n",
        " " + TEST_SIGNING_KEY,
    ],
    ids=[
        "empty", "short", "undersized", "repeated-character", "repeated-byte",
        "repeated-block", "non-hex", "example", "newline", "leading-whitespace",
    ],
)
def test_invalid_or_placeholder_signing_keys_fail_closed(invalid_key, caplog):
    with pytest.raises(ValidationError, match="JWT_SECRET_KEY") as captured:
        _settings(jwt_secret_key=invalid_key)

    logging.getLogger(__name__).error("Configuration rejected: %s", captured.value)
    if invalid_key:
        assert invalid_key not in str(captured.value)
        assert invalid_key not in repr(captured.value)
        assert invalid_key not in caplog.text


def test_explicit_signing_key_loads_from_environment_and_is_redacted(monkeypatch):
    monkeypatch.setenv("JWT_SECRET_KEY", TEST_SIGNING_KEY)
    configured = _settings()

    assert configured.jwt_secret_key.get_secret_value() == TEST_SIGNING_KEY
    assert TEST_SIGNING_KEY not in repr(configured)
    assert TEST_SIGNING_KEY not in configured.model_dump_json()


@pytest.mark.parametrize("auth_disabled", [False, True])
def test_configuration_import_refuses_to_start_without_signing_key(tmp_path, auth_disabled):
    # Minimal isolated environment: never read the host's real runtime env file.
    result = subprocess.run(
        [sys.executable, "-c", "import app.core.config"],
        cwd=tmp_path,
        env={
            "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
            "DATABASE_URL": "postgresql://test",
            "REDIS_URL": "redis://test",
            "AUTH_DISABLED": str(auth_disabled).lower(),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert "jwt_secret_key" in result.stderr
    assert "Field required" in result.stderr


def test_configuration_import_errors_never_echo_the_invalid_input(tmp_path):
    invalid_key = "private-looking-synthetic-input-that-must-never-appear-in-logs"
    result = subprocess.run(
        [sys.executable, "-c", "import app.core.config"],
        cwd=tmp_path,
        env={
            "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
            "DATABASE_URL": "postgresql://test",
            "REDIS_URL": "redis://test",
            "JWT_SECRET_KEY": invalid_key,
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert "JWT_SECRET_KEY" in result.stderr
    assert invalid_key not in result.stdout + result.stderr


def test_access_and_refresh_tokens_use_only_the_configured_signing_key():
    now = datetime.now(timezone.utc).timestamp()
    tokens = security.AuthUtils.create_tokens(42, "jwt-test@example.invalid", "user")

    assert set(tokens) == {"access_token", "refresh_token", "token_type"}
    assert tokens["token_type"] == "bearer"
    access = jwt.decode(tokens["access_token"], TEST_SIGNING_KEY, algorithms=["HS256"])
    refresh = jwt.decode(tokens["refresh_token"], TEST_SIGNING_KEY, algorithms=["HS256"])
    assert access["sub"] == refresh["sub"] == "42"
    assert access["email"] == refresh["email"] == "jwt-test@example.invalid"
    assert access["role"] == "user"
    assert refresh["type"] == "refresh"
    assert abs(access["exp"] - now - 15 * 60) < 2
    assert abs(refresh["exp"] - now - 7 * 24 * 60 * 60) < 2
    assert security.JWTUtils.verify_token(tokens["access_token"]) == access
    assert security.JWTUtils.verify_token(tokens["refresh_token"]) == refresh


@pytest.mark.parametrize("token_type", ["access", "refresh"])
def test_rotating_configuration_invalidates_existing_tokens(monkeypatch, token_type):
    tokens = security.AuthUtils.create_tokens(42, "jwt-test@example.invalid", "user")
    monkeypatch.setattr(security.settings, "jwt_secret_key", SecretStr(OTHER_SIGNING_KEY))

    assert security.JWTUtils.verify_token(tokens[f"{token_type}_token"]) is None
    replacement = security.AuthUtils.create_tokens(42, "jwt-test@example.invalid", "user")
    assert security.JWTUtils.verify_token(replacement[f"{token_type}_token"]) is not None


@pytest.mark.parametrize("token_type", ["access", "refresh"])
def test_tokens_signed_with_another_key_are_never_accepted(token_type):
    payload = {
        "sub": "42",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    }
    if token_type == "refresh":
        payload["type"] = "refresh"
    foreign_token = jwt.encode(payload, OTHER_SIGNING_KEY, algorithm="HS256")

    assert security.JWTUtils.verify_token(foreign_token) is None


def test_expired_malformed_and_other_algorithm_tokens_remain_rejected():
    expired = security.JWTUtils.create_access_token(
        42, "jwt-test@example.invalid", "user", expires_delta=timedelta(seconds=-5)
    )
    wrong_algorithm = jwt.encode({"sub": "42"}, TEST_SIGNING_KEY, algorithm="HS512")

    assert security.JWTUtils.verify_token(expired) is None
    assert security.JWTUtils.verify_token("malformed") is None
    assert security.JWTUtils.verify_token(wrong_algorithm) is None
