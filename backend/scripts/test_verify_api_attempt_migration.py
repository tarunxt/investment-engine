"""Offline tests: no Alembic commands or PostgreSQL connections are executed."""

import json
from copy import deepcopy
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

    def forward_snapshots(self):
        before = {"outbox": {"columns": [("id", "UUID", False, None)], "rows": [json.dumps({"id":"synthetic"},sort_keys=True)], "indexes":[]}}
        after = deepcopy(before)
        after["outbox"]["columns"] += [("available_at", "TIMESTAMP", True, None), ("execution_attempts", "INTEGER", False, "0")]
        after["outbox"]["rows"] = [json.dumps({"id":"synthetic","available_at":None,"execution_attempts":0},sort_keys=True)]
        return before,after

    def test_only_exact_stage04_additions_preserve_forward_baseline(self):
        before,after=self.forward_snapshots()
        verifier.require_forward_baseline_preserved(before,after)
        self.assertEqual(len(after["outbox"]["columns"]),3, "Verifier must not mutate evidence")
        verifier.require_forward_baseline_preserved(before,before)

    def test_forward_head_still_rejects_old_data_schema_and_constraint_changes(self):
        before,after=self.forward_snapshots()
        for kind in ("old-value","old-column","index","legacy-attempt"):
            changed=deepcopy(after)
            if kind=="old-value": changed["outbox"]["rows"]=[json.dumps({"id":"changed","available_at":None,"execution_attempts":0},sort_keys=True)]
            elif kind=="old-column": changed["outbox"]["columns"][0]=("id","TEXT",False,None)
            elif kind=="index": changed["outbox"]["indexes"]=["unexpected"]
            else: changed["outbox"]["rows"]=[json.dumps({"id":"synthetic","available_at":None,"execution_attempts":1},sort_keys=True)]
            with self.subTest(kind=kind),self.assertRaises(AssertionError): verifier.require_forward_baseline_preserved(before,changed)

    def test_forward_head_rejects_any_unapproved_addition_or_default(self):
        before,after=self.forward_snapshots()
        for kind in ("extra","partial","type","default"):
            changed=deepcopy(after)
            if kind=="extra": changed["outbox"]["columns"].append(("unapproved","TEXT",True,None))
            elif kind=="partial": changed["outbox"]["columns"].pop()
            elif kind=="type": changed["outbox"]["columns"][1]=("available_at","TEXT",True,None)
            else: changed["outbox"]["columns"][2]=("execution_attempts","INTEGER",False,"1")
            with self.subTest(kind=kind),self.assertRaises(AssertionError): verifier.require_forward_baseline_preserved(before,changed)

    def stage11_snapshots(self):
        table='indmoney_us_portfolio_snapshots'
        base={'columns':[('id','INTEGER',False,None),('user_id','INTEGER',False,None)],
              'rows':[json.dumps({'id':1,'user_id':7},sort_keys=True)],'indexes':[],
              'unique':[],'foreign_keys':[],'checks':[],'primary_key':{'name':'old_pk','constrained_columns':['id']}}
        before={table:base};after=deepcopy(before);item=after[table]
        item['columns'] += [('acceptance_state','VARCHAR(24)',False,"'legacy_unverified'::character varying"),
            ('import_key','VARCHAR(64)',True,None),('content_hash','VARCHAR(64)',True,None),
            ('import_provenance','JSON',True,None),('accepted_at','TIMESTAMP',True,None),('supersedes_id','INTEGER',True,None)]
        item['rows']=[json.dumps({'id':1,'user_id':7,'acceptance_state':'legacy_unverified',
            **{name:None for name in ['import_key','content_hash','import_provenance','accepted_at','supersedes_id']}},sort_keys=True)]
        item['unique']=[{'name':'uq_indmoney_owner_import','column_names':['user_id','import_key'],'comment':None,'dialect_options':{'postgresql_include':[],'postgresql_nulls_not_distinct':False}}]
        item['indexes']=[{'name':'uq_indmoney_owner_import','column_names':['user_id','import_key'],'unique':True,'duplicates_constraint':'uq_indmoney_owner_import','include_columns':[],'dialect_options':{'postgresql_include':[]}}]
        item['foreign_keys']=[{'name':'fk_indmoney_correction','constrained_columns':['supersedes_id'],'referred_schema':None,'referred_table':table,'referred_columns':['id'],'options':{'ondelete':'RESTRICT'}}]
        return before,after

    def test_exact_stage11_additions_preserve_legacy_without_mutating_receipt(self):
        before,after=self.stage11_snapshots();saved=deepcopy(after)
        verifier.require_forward_baseline_preserved(before,after)
        self.assertEqual(after,saved)
        verifier.require_forward_baseline_preserved(before,before)

    def test_stage11_forward_check_rejects_column_constraint_and_data_drift(self):
        before,after=self.stage11_snapshots();table='indmoney_us_portfolio_snapshots'
        mutations={
            'partial':lambda x:x['columns'].pop(),
            'extra':lambda x:x['columns'].append(('unexpected','TEXT',True,None)),
            'old_type':lambda x:x['columns'].__setitem__(0,('id','TEXT',False,None)),
            'new_type':lambda x:x['columns'].__setitem__(2,('acceptance_state','TEXT',False,"'legacy_unverified'")),
            'default':lambda x:x['columns'].__setitem__(2,('acceptance_state','VARCHAR(24)',False,"'accepted'")),
            'nullable':lambda x:x['columns'].__setitem__(3,('import_key','VARCHAR(64)',False,None)),
            'unique_columns':lambda x:x['unique'][0].update(column_names=['import_key']),
            'unique_nulls':lambda x:x['unique'][0]['dialect_options'].update(postgresql_nulls_not_distinct=True),
            'index_unique':lambda x:x['indexes'][0].update(unique=False),
            'index_extra':lambda x:x['indexes'][0].update(unknown='ignored?'),
            'fk_delete':lambda x:x['foreign_keys'][0]['options'].update(ondelete='CASCADE'),
            'fk_target':lambda x:x['foreign_keys'][0].update(referred_table='users'),
            'fk_missing':lambda x:x['foreign_keys'].clear(),
            'old_constraint':lambda x:x['checks'].append({'name':'new','sqltext':'false'}),
            'old_row':lambda x:x['rows'].__setitem__(0,x['rows'][0].replace('"user_id": 7','"user_id": 8')),
            'accepted_legacy':lambda x:x['rows'].__setitem__(0,x['rows'][0].replace('legacy_unverified','accepted')),
            'invented_hash':lambda x:x['rows'].__setitem__(0,x['rows'][0].replace('"content_hash": null','"content_hash": "invented"'))}
        for name,mutate in mutations.items():
            changed=deepcopy(after);mutate(changed[table])
            with self.subTest(mutation=name),self.assertRaises(AssertionError):verifier.require_forward_baseline_preserved(before,changed)

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
