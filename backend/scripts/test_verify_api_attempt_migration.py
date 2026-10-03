"""Offline tests: no Alembic commands or PostgreSQL connections are executed."""

from pathlib import Path
import unittest
from unittest.mock import patch

import yaml

import verify_api_attempt_migration as verifier


class MigrationSafetyTests(unittest.TestCase):
    def environment(self):
        return {**verifier.TEST_ENVIRONMENT, "PATH": "/usr/local/bin:/usr/bin"}

    @patch.object(Path, "exists", return_value=False)
    @patch.object(Path, "is_file", return_value=True)
    def test_exact_test_environment_strips_inherited_credentials_and_overrides(self, *_):
        environment = self.environment()
        environment.update(OPENAI_API_KEY="synthetic-forbidden-value", PGHOST="elsewhere.invalid", PGOPTIONS="unsafe", AWS_PROFILE="production")
        clean = verifier.guarded_environment(environment)
        self.assertEqual(clean["DATABASE_URL"], verifier.TEST_DATABASE_URL)
        for key in ("OPENAI_API_KEY", "PGHOST", "PGOPTIONS", "AWS_PROFILE"):
            self.assertNotIn(key, clean)

    def test_refuses_environment_or_url_changes_before_database_or_alembic(self):
        unsafe_values = {
            "DATABASE_URL": [
                "postgresql://user:synthetic@production.invalid/db",
                verifier.TEST_DATABASE_URL + "?host=production.invalid",
                verifier.TEST_DATABASE_URL.replace("postgres:5432", "localhost:5432"),
                verifier.TEST_DATABASE_URL.replace("api_attempt_migration_test", "production"),
                verifier.TEST_DATABASE_URL.replace("migration_test:migration_test", "postgres:migration_test"),
                "sqlite://",
            ],
            "ENVIRONMENT": ["production", "staging"],
            "CI": ["false", ""],
            "GITHUB_ACTIONS": ["false", ""],
            "API_ATTEMPT_MIGRATION_TEST": ["", "true"],
            "REDIS_URL": ["redis://production.invalid:6379/0"],
        }
        with patch.object(verifier.sa, "create_engine") as connect, patch.object(verifier.subprocess, "run") as run:
            for key, values in unsafe_values.items():
                for value in values:
                    with self.subTest(key=key, value=value), patch.dict(verifier.os.environ, {**self.environment(), key: value}, clear=True):
                        with self.assertRaises(RuntimeError):
                            verifier.main()
            connect.assert_not_called()
            run.assert_not_called()

    @patch.object(Path, "is_file", return_value=False)
    def test_refuses_non_docker_execution(self, _):
        with self.assertRaisesRegex(RuntimeError, "Docker"):
            verifier.guarded_environment(self.environment())

    @patch.object(Path, "exists", return_value=True)
    @patch.object(Path, "is_file", return_value=True)
    def test_refuses_backend_dotenv(self, *_):
        with self.assertRaisesRegex(RuntimeError, r"\.env"):
            verifier.guarded_environment(self.environment())

    @patch.object(verifier, "guarded_environment", side_effect=RuntimeError("unsafe"))
    def test_each_alembic_invocation_is_guarded(self, _):
        with patch.object(verifier.subprocess, "run") as run:
            with self.assertRaises(RuntimeError):
                verifier.alembic("downgrade", verifier.BASELINE)
            run.assert_not_called()

    def test_workflow_uses_ephemeral_containers_without_production_access(self):
        workflow_path = verifier.BACKEND.parent / ".github/workflows/api-attempt-migration.yml"
        source = workflow_path.read_text()
        # BaseLoader keeps YAML's `on` a string instead of treating it as a boolean.
        workflow = yaml.load(source, Loader=yaml.BaseLoader)
        self.assertEqual(set(workflow["on"]), {"pull_request"})
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        self.assertEqual(set(workflow["jobs"]), {"migration-roundtrip"})
        job = workflow["jobs"]["migration-roundtrip"]
        self.assertEqual(job["container"], "python:3.13-slim")
        self.assertEqual(set(job["services"]), {"postgres"})
        service = job["services"]["postgres"]
        self.assertEqual(service["image"], "postgres:16")
        self.assertNotIn("ports", service)
        self.assertNotIn("volumes", service)
        self.assertNotIn("environment", job)
        for key, value in verifier.TEST_ENVIRONMENT.items():
            if key != "GITHUB_ACTIONS":  # Provided by GitHub, not spoofed by the job.
                self.assertEqual(job["env"][key], value)
        self.assertEqual(job["steps"][0]["with"]["persist-credentials"], "false")
        self.assertEqual(job["steps"][-1]["run"], "python scripts/verify_api_attempt_migration.py")
        for forbidden in ("secrets.", "pull_request_target", "workflow_dispatch", "ssh ", "release-prod", "docker build"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
