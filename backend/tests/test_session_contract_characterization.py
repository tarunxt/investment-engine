"""Synthetic source characterization, without app startup or real credentials.

Strict xfails identify open acceptance gaps; they are not completed controls.
This extracts the real JWTUtils class while replacing configuration and hashing
imports, so these checks do not cover API, database, or dependency wiring.
"""
import ast
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional

import pytest
from jose import JWTError, jwt


@pytest.fixture
def verifier():
    source = Path(__file__).parents[1] / "app/core/security.py"
    tree = ast.parse(source.read_text())
    utils = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "JWTUtils")
    namespace = dict(datetime=datetime, timedelta=timedelta, Optional=Optional,
                     Dict=Dict, Any=Any, jwt=jwt, JWTError=JWTError,
                     SECRET_KEY="synthetic-test-key-only-" * 3, ALGORITHM="HS256",
                     ACCESS_TOKEN_EXPIRE_MINUTES=15, REFRESH_TOKEN_EXPIRE_DAYS=7)
    exec(compile(ast.Module(body=[utils], type_ignores=[]), str(source), "exec"), namespace)
    return namespace["JWTUtils"], namespace


def test_intended_access_and_refresh_are_signed_and_accepted(verifier):
    utils, _ = verifier
    access = utils.create_access_token(42, "fixture@example.invalid", "user")
    refresh = utils.create_refresh_token(42, "fixture@example.invalid")
    assert utils.verify_token(access)["sub"] == "42"
    assert utils.verify_token(refresh)["type"] == "refresh"


def test_expired_access_is_denied(verifier):
    utils, _ = verifier
    token = utils.create_access_token(42, "fixture@example.invalid", "user", timedelta(seconds=-60))
    assert utils.verify_token(token) is None


def test_invalid_signature_is_denied(verifier):
    utils, _ = verifier
    token = jwt.encode({"sub": "42", "exp": datetime.utcnow() + timedelta(minutes=1)},
                       "different-synthetic-key-only", algorithm="HS256")
    assert utils.verify_token(token) is None


@pytest.mark.xfail(strict=True, reason="A9-003-A02: general verifier accepts refresh credentials")
def test_general_access_verifier_denies_refresh(verifier):
    utils, _ = verifier
    assert utils.verify_token(utils.create_refresh_token(42, "fixture@example.invalid")) is None


@pytest.mark.xfail(strict=True, reason="A9-003-A02: expiry is not currently required")
def test_missing_expiry_is_denied(verifier):
    utils, config = verifier
    token = jwt.encode({"sub": "42"}, config["SECRET_KEY"], algorithm="HS256")
    assert utils.verify_token(token) is None


@pytest.mark.xfail(strict=True, reason="A9-003-A01/A02: issuer and audience contract pending")
def test_wrong_issuer_is_denied(verifier):
    utils, config = verifier
    token = jwt.encode({"sub": "42", "iss": "untrusted-fixture", "exp": datetime.utcnow() + timedelta(minutes=1)},
                       config["SECRET_KEY"], algorithm="HS256")
    assert utils.verify_token(token) is None
