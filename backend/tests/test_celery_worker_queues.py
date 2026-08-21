"""Regression coverage for the no-Docker primary Celery worker queue contract."""

from __future__ import annotations

from pathlib import Path
import shlex
import subprocess


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_COMMON = REPOSITORY_ROOT / "deploy/no-docker/scripts/runtime-common.sh"
PRIMARY_WORKER_SCRIPT = REPOSITORY_ROOT / "deploy/no-docker/scripts/run-celery-worker.sh"
EMAIL_WORKER_SCRIPT = REPOSITORY_ROOT / "deploy/no-docker/scripts/run-celery-email-worker.sh"


def _effective_queues(configured_queues: str) -> subprocess.CompletedProcess[str]:
    command = (
        f"source {shlex.quote(str(RUNTIME_COMMON))}; "
        f"primary_celery_worker_effective_queues {shlex.quote(configured_queues)}"
    )
    return subprocess.run(
        ["bash", "-c", command],
        check=False,
        text=True,
        capture_output=True,
    )


def test_primary_worker_adds_ai_when_config_omits_it_and_isolates_extra_queues():
    result = _effective_queues(" email, auto_live , custom ")

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ai"
    assert "WARNING: CELERY_WORKER_QUEUES omitted mandatory queue ai" in result.stderr
    assert "email is isolated on the dedicated email worker" in result.stderr


def test_primary_worker_is_ai_only_when_legacy_config_contains_email():
    result = _effective_queues(" ai, email , custom ")

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ai"
    assert "omitted mandatory queue ai" not in result.stderr
    assert "email is isolated on the dedicated email worker" in result.stderr


def test_primary_worker_launch_uses_the_normalized_effective_queue_list():
    script = PRIMARY_WORKER_SCRIPT.read_text()

    assert "primary_celery_worker_effective_queues" in script
    assert "Investor primary Celery worker effective queue list" in script
    assert '-Q "$EFFECTIVE_CELERY_WORKER_QUEUES"' in script
    assert 'CELERY_AI_WORKER_CONCURRENCY:-1' in script


def test_email_worker_has_one_dedicated_pool_without_adding_total_concurrency():
    script = EMAIL_WORKER_SCRIPT.read_text()

    assert "-Q email" in script
    assert "CELERY_EMAIL_WORKER_CONCURRENCY:-1" in script
    assert 'email-worker@%h' in script
