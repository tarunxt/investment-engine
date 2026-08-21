from __future__ import annotations

from functools import lru_cache
import hashlib
import os
from pathlib import Path
import subprocess
from typing import Any

from alembic.config import Config
from alembic.script import ScriptDirectory

from app.domains.bullpen_run_audit.constants import (
    AUDITED_ALGORITHM_REGISTRY,
    BULLPEN_AUDIT_CRITICAL_SOURCE_FILES,
    BULLPEN_RUN_AUDIT_ALGORITHM_REGISTRY_VERSION,
    BULLPEN_RUN_AUDIT_PROMPT_VERSION,
    BULLPEN_RUN_AUDIT_RULE_VERSION,
    BULLPEN_RUN_AUDIT_SCHEMA_VERSION,
    SNAPSHOT_SOURCE_NATIVE,
)
from app.domains.bullpen_run_audit.sanitizer import sanitize_secret_value
from app.domains.polymarket.bullpen_llm_execution import build_bullpen_prompt_template_hash

REPO_ROOT = Path(__file__).resolve().parents[4]
BACKEND_ROOT = REPO_ROOT / "backend"
ALEMBIC_CONFIG_PATH = BACKEND_ROOT / "alembic.ini"


def stable_sha256(value: Any) -> str:
    import json

    payload = json.dumps(
        sanitize_secret_value(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _git_head_sha() -> str | None:
    try:
        output = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=REPO_ROOT,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except Exception:
        return None
    return output or None


def _git_head_short_sha() -> str | None:
    head = _git_head_sha()
    if not head:
        return None
    return head[:12]


def _environment_first(*keys: str) -> str | None:
    for key in keys:
        value = (os.getenv(key) or "").strip()
        if value:
            return value
    return None


def resolve_backend_commit_sha() -> str | None:
    return _environment_first(
        "BACKEND_GIT_COMMIT_SHA",
        "GIT_COMMIT_SHA",
        "VERCEL_GIT_COMMIT_SHA",
        "RENDER_GIT_COMMIT",
    ) or _git_head_sha()


def resolve_frontend_build_sha() -> str | None:
    return _environment_first(
        "FRONTEND_BUILD_SHA",
        "NEXT_PUBLIC_FRONTEND_BUILD_SHA",
        "NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA",
        "VERCEL_GIT_COMMIT_SHA",
    ) or _git_head_short_sha()


def resolve_deployment_id() -> str | None:
    return _environment_first(
        "DEPLOYMENT_ID",
        "RELEASE_ID",
        "VERCEL_DEPLOYMENT_ID",
        "RENDER_SERVICE_ID",
    )


def resolve_build_time() -> str | None:
    return _environment_first(
        "BUILD_TIME_UTC",
        "BUILD_TIME",
        "RELEASE_CREATED_AT",
    )


def resolve_alembic_revision() -> str | None:
    explicit = _environment_first("ALEMBIC_REVISION")
    if explicit:
        return explicit
    try:
        config = Config(str(ALEMBIC_CONFIG_PATH))
        config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
        script_dir = ScriptDirectory.from_config(config)
    except Exception:
        return None
    heads = script_dir.get_heads()
    return ",".join(sorted(heads)) if heads else None


@lru_cache(maxsize=1)
def critical_source_manifest() -> dict[str, str]:
    manifest: dict[str, str] = {}
    for relative_path in BULLPEN_AUDIT_CRITICAL_SOURCE_FILES:
        file_path = REPO_ROOT / relative_path
        try:
            digest = hashlib.sha256(file_path.read_bytes()).hexdigest()
        except FileNotFoundError:
            digest = "missing"
        manifest[relative_path] = digest
    return manifest


def build_native_run_audit_metadata(
    *,
    settings_snapshot: dict[str, Any],
    prompt_template: str | None = None,
    execution_version: str | None = None,
    strategy_version: str | None = None,
) -> dict[str, Any]:
    sanitized_settings = sanitize_secret_value(settings_snapshot)
    prompt_hash = (
        build_bullpen_prompt_template_hash(prompt_template)
        if prompt_template is not None
        else None
    )
    return {
        "capture_mode": SNAPSHOT_SOURCE_NATIVE,
        "audit_schema_version": BULLPEN_RUN_AUDIT_SCHEMA_VERSION,
        "audit_rule_version": BULLPEN_RUN_AUDIT_RULE_VERSION,
        "audit_prompt_version": BULLPEN_RUN_AUDIT_PROMPT_VERSION,
        "algorithm_registry_version": BULLPEN_RUN_AUDIT_ALGORITHM_REGISTRY_VERSION,
        "execution_version": execution_version,
        "strategy_version": strategy_version,
        "settings_snapshot": sanitized_settings,
        "settings_hash": stable_sha256(sanitized_settings),
        "prompt_hashes": {
            "stage2_console_prompt_template": prompt_hash,
        },
        "code_provenance": {
            "backend_commit_sha": resolve_backend_commit_sha(),
            "frontend_build_sha": resolve_frontend_build_sha(),
            "deployment_id": resolve_deployment_id(),
            "build_time": resolve_build_time(),
            "alembic_revision": resolve_alembic_revision(),
            "audit_schema_version": BULLPEN_RUN_AUDIT_SCHEMA_VERSION,
            "audit_prompt_version": BULLPEN_RUN_AUDIT_PROMPT_VERSION,
            "audit_rule_version": BULLPEN_RUN_AUDIT_RULE_VERSION,
            "algorithm_registry_version": BULLPEN_RUN_AUDIT_ALGORITHM_REGISTRY_VERSION,
            "critical_source_manifest": critical_source_manifest(),
            "critical_source_manifest_hash": stable_sha256(critical_source_manifest()),
            "audited_algorithm_registry": list(AUDITED_ALGORITHM_REGISTRY),
        },
    }

