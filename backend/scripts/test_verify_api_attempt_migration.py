"""Offline tests: no Alembic commands or PostgreSQL connections are executed."""

from pathlib import Path
from copy import deepcopy
import json
import unittest
from unittest.mock import patch

import yaml

import verify_api_attempt_migration as verifier


class MigrationSafetyTests(unittest.TestCase):
    def test_forward_policy_allows_only_nullable_column_and_preserves_prior_facts(self):
        prior = {"auto_rebalance_workflows": {"columns": [("id", "INTEGER", False, None)], "rows": [json.dumps({"id": 1}, sort_keys=True)], "indexes": []}}
        valid = deepcopy(prior)
        valid["auto_rebalance_workflows"]["columns"].append(("side_effect_policy_json", "JSON", True, None))
        valid["auto_rebalance_workflows"]["rows"] = [json.dumps({"id": 1, "side_effect_policy_json": None}, sort_keys=True)]
        untouched = deepcopy(valid)
        verifier.verify_forward_baseline(prior, valid)
        self.assertEqual(valid, untouched)
        for field in ("type", "nullable", "default", "old_row", "new_value", "index", "extra_column"):
            changed = deepcopy(valid)
            workflow = changed["auto_rebalance_workflows"]
            if field in {"type", "nullable", "default"}:
                workflow["columns"][-1] = {"type": ("side_effect_policy_json", "TEXT", True, None), "nullable": ("side_effect_policy_json", "JSON", False, None), "default": ("side_effect_policy_json", "JSON", True, "{}")}[field]
            elif field == "old_row": workflow["rows"] = [json.dumps({"id": 2, "side_effect_policy_json": None}, sort_keys=True)]
            elif field == "new_value": workflow["rows"] = [json.dumps({"id": 1, "side_effect_policy_json": {}}, sort_keys=True)]
            elif field == "index": workflow["indexes"].append({"name": "unexpected"})
            else: workflow["columns"].append(("unexpected", "JSON", True, None))
            with self.subTest(field=field), self.assertRaises(AssertionError):
                verifier.verify_forward_baseline(prior, changed)

    def test_forward_dispatch_exact_additions_and_negative_controls(self):
        prior = {"outbox": {
            "columns": [("id", "UUID", False, None)],
            "rows": [json.dumps({"id": "historical"}, sort_keys=True)],
            "indexes": [{"name": "legacy_idx", "column_names": ["id"], "unique": False}],
            "unique": [], "foreign_keys": [], "checks": [],
            "primary_key": {"name": "outbox_pkey", "constrained_columns": ["id"]},
        }}
        valid = deepcopy(prior)
        box = valid["outbox"]
        columns = [("job_id", "INTEGER", True, None), ("state", "VARCHAR(32)", True, None),
                   ("claim_token", "VARCHAR(36)", True, None),
                   ("next_attempt_at", "TIMESTAMP WITH TIME ZONE", True, None),
                   ("last_error_type", "VARCHAR(100)", True, None)]
        box["columns"] += columns
        box["rows"] = [json.dumps({"id": "historical", **{c[0]: None for c in columns}}, sort_keys=True)]
        box["foreign_keys"] = [{"name": "fk_outbox_job_id", "constrained_columns": ["job_id"],
                                 "referred_schema": None, "referred_table": "jobs", "referred_columns": ["id"],
                                 "options": {}, "comment": None}]
        box["unique"] = [{"name": "uq_outbox_job_id", "column_names": ["job_id"], "comment": None,
                          "dialect_options": {"postgresql_include": [], "postgresql_nulls_not_distinct": False}}]
        box["indexes"] += [
            {"name": "ix_outbox_state", "unique": False, "column_names": ["state"],
             "include_columns": [], "dialect_options": {"postgresql_include": []}},
            {"name": "uq_outbox_job_id", "unique": True, "column_names": ["job_id"],
             "duplicates_constraint": "uq_outbox_job_id", "include_columns": [],
             "dialect_options": {"postgresql_include": []}},
        ]
        untouched = deepcopy(valid)
        verifier.verify_forward_baseline(prior, valid)
        self.assertEqual(valid, untouched)
        mutations = {
            "column_missing": lambda b: b["columns"].pop(),
            "column_type": lambda b: b["columns"].__setitem__(1, ("job_id", "BIGINT", True, None)),
            "column_nonnullable": lambda b: b["columns"].__setitem__(1, ("job_id", "INTEGER", False, None)),
            "column_default": lambda b: b["columns"].__setitem__(1, ("job_id", "INTEGER", True, "1")),
            "timezone_lost": lambda b: b["columns"].__setitem__(4, ("next_attempt_at", "TIMESTAMP WITHOUT TIME ZONE", True, None)),
            "extra_column": lambda b: b["columns"].append(("unapproved", "TEXT", True, None)),
            "old_column": lambda b: b["columns"].__setitem__(0, ("id", "TEXT", False, None)),
            "old_row": lambda b: b["rows"].__setitem__(0, b["rows"][0].replace('historical', 'changed')),
            "new_value": lambda b: b["rows"].__setitem__(0, b["rows"][0].replace('"state": null', '"state": "pending"')),
            "old_index": lambda b: b["indexes"].pop(0),
            "missing_index": lambda b: b["indexes"].pop(1),
            "duplicate_index": lambda b: b["indexes"].append(deepcopy(b["indexes"][1])),
            "partial_index": lambda b: b["indexes"][1]["dialect_options"].update(postgresql_where="state IS NOT NULL"),
            "covering_index": lambda b: b["indexes"][1].update(include_columns=["id"]),
            "unique_changed": lambda b: b["unique"][0].update(column_names=["id"]),
            "null_uniqueness": lambda b: b["unique"][0]["dialect_options"].update(postgresql_nulls_not_distinct=True),
            "foreign_target": lambda b: b["foreign_keys"][0].update(referred_table="users"),
            "foreign_cascade": lambda b: b["foreign_keys"][0]["options"].update(ondelete="CASCADE"),
            "old_pk": lambda b: b["primary_key"].update(constrained_columns=[]),
            "check_added": lambda b: b["checks"].append({"name": "unapproved"}),
        }
        for name, mutation in mutations.items():
            changed = deepcopy(valid)
            mutation(changed["outbox"])
            with self.subTest(mutation=name), self.assertRaises(AssertionError):
                verifier.verify_forward_baseline(prior, changed)

    def environment(self):
        return {**verifier.TEST_ENVIRONMENT, "PATH": "/usr/local/bin:/usr/bin"}

    @patch.object(Path, "exists", return_value=False)
    @patch.object(Path, "is_file", return_value=True)
    def test_exact_test_environment_strips_inherited_credentials_and_overrides(self, *_):
        environment = self.environment()
        environment.update(OPENAI_API_KEY="synthetic-forbidden-value", PGHOST="elsewhere.invalid", PGOPTIONS="unsafe", AWS_PROFILE="production",
                           JWT_SIGNING_KEY="synthetic-inherited-key", JWT_SECRET="synthetic-alias", SECRET_KEY="synthetic-alias")
        clean = verifier.guarded_environment(environment)
        self.assertEqual(clean["DATABASE_URL"], verifier.TEST_DATABASE_URL)
        self.assertEqual(clean["JWT_SIGNING_KEY"], bytes(range(32)).hex())
        for key in ("OPENAI_API_KEY", "PGHOST", "PGOPTIONS", "AWS_PROFILE", "JWT_SECRET", "SECRET_KEY"):
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
