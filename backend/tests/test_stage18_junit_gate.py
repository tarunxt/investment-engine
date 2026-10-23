import hashlib
import xml.etree.ElementTree as ET
import tempfile
from pathlib import Path
import unittest
from scripts.public_launch.stage18_junit_gate import verify, REQUIRED_MODULES


# Independent case identities from the passing rehearsal at source
# 651a3bf0287bf9bf97cc4f935d126dbbb98e0de9, run 39954495927.
# This synthetic report is a gate regression fixture, not execution evidence.
EXECUTED_CASES = {'test_stage18_migrations_postgres': [('backend.tests.test_stage18_migrations_postgres',
                                       'test_actual_multiuser_migration_idempotence_and_connection_ownership'),
                                      ('backend.tests.test_stage18_migrations_postgres',
                                       'test_actual_failed_migration_transaction_restores_schema_rows_and_revision'),
                                      ('backend.tests.test_stage18_migrations_postgres',
                                       'test_actual_pg_dump_restore_preserves_every_fixture_row_and_sequence'),
                                      ('backend.tests.test_stage18_migrations_postgres',
                                       'test_actual_concurrent_google_signup_preserves_independent_defaults'),
                                      ('backend.tests.test_stage18_migrations_postgres',
                                       'test_actual_check_cast_forms_preserve_constraint_semantics[value::text '
                                       "= ANY (ARRAY['user_owned'::character varying, "
                                       "'platform_managed'::character varying]::text[])]"),
                                      ('backend.tests.test_stage18_migrations_postgres',
                                       'test_actual_check_cast_forms_preserve_constraint_semantics[value::text '
                                       "= ANY (ARRAY['user_owned'::character varying::text, "
                                       "'platform_managed'::character varying::text])]")],
 'test_stage18_queue_redis': [('backend.tests.test_stage18_queue_redis',
                               'test_actual_redis_redelivery_preserves_bound_owner_version_and_task_id')],
 'test_stage18_migration_invariants': [('backend.tests.test_stage18_migration_invariants.MigrationInvariants',
                                        'test_closed_projection_rejects_credentials_boolean_ids_and_orphans'),
                                       ('backend.tests.test_stage18_migration_invariants.MigrationInvariants',
                                        'test_failed_transaction_snapshot_must_roll_back_all_partial_changes'),
                                       ('backend.tests.test_stage18_migration_invariants.MigrationInvariants',
                                        'test_foreign_connection_copy_history_move_or_order_approval_rejected'),
                                       ('backend.tests.test_stage18_migration_invariants.MigrationInvariants',
                                        'test_legacy_and_google_account_ids_roles_disabled_status_preserved'),
                                       ('backend.tests.test_stage18_migration_invariants.MigrationInvariants',
                                        'test_new_account_optional_module_or_admin_grant_rejected'),
                                       ('backend.tests.test_stage18_migration_invariants.MigrationInvariants',
                                        'test_pending_incompatible_work_or_rebinding_rejected'),
                                       ('backend.tests.test_stage18_migration_invariants.MigrationInvariants',
                                        'test_preservation_new_defaults_quarantine_and_counts'),
                                       ('backend.tests.test_stage18_migration_invariants.MigrationInvariants',
                                        'test_repeated_initialization_snapshot_has_stable_per_owner_counts'),
                                       ('backend.tests.test_stage18_migration_invariants.MigrationInvariants',
                                        'test_unknown_roles_and_connection_modes_reject'),
                                       ('backend.tests.test_stage18_migration_invariants.MigrationInvariants',
                                        'test_unresolved_ownership_never_assigned_to_logged_in_owner'),
                                       ('backend.tests.test_stage18_migration_invariants.CheckRenderingInvariants',
                                        'test_changed_constraint_semantics_remain_different'),
                                       ('backend.tests.test_stage18_migration_invariants.CheckRenderingInvariants',
                                        'test_only_known_lossless_array_cast_rendering_is_equivalent'),
                                       ('backend.tests.test_stage18_migration_invariants.CheckRenderingInvariants',
                                        'test_unsupported_sql_is_preserved_exactly')],
 'test_stage18_signup_clock': [('backend.tests.test_stage18_signup_clock',
                                'test_default_clock_is_sampled_after_control_acquisition'),
                               ('backend.tests.test_stage18_signup_clock',
                                'test_explicit_rollback_time_is_not_overridden_after_control')],
 'test_stage18_asgi_load': [('backend.tests.test_stage18_asgi_load',
                             'test_bounded_signed_owner_other_admin_and_anonymous_asgi_load')]}


class JunitGate(unittest.TestCase):
    def report(self):
        root = ET.Element('testsuites')
        suite = ET.SubElement(root, 'testsuite')
        for cases in EXECUTED_CASES.values():
            for classname, name in cases:
                ET.SubElement(suite, 'testcase', classname=classname, name=name)
        return ET.tostring(root, encoding='unicode')

    def run_report(self, data, sha='a'*40):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'tests.xml'; path.write_text(data)
            return verify(path, source_sha=sha)

    def test_complete_execution_receipt_is_not_full_acceptance(self):
        report = self.run_report(self.report())
        self.assertEqual(report['executed'], 23)
        self.assertFalse(report['full_release_verified'])
        self.assertFalse(report['browser_load_verified'])

    def test_actual_pytest_unittest_classnames_keep_module_identity(self):
        self.assertEqual(self.run_report(self.report())['executed'], 23)
        root = ET.fromstring(self.report())
        for case in root.findall('.//testcase'):
            module = next(part for part in case.get('classname').split('.')
                          if part.startswith('test_'))
            case.set('classname', module)
        self.assertEqual(self.run_report(ET.tostring(root, encoding='unicode'))['executed'], 23)

    def test_skips_xfail_failures_and_collection_errors_rejected(self):
        for child in ('skipped', 'failure', 'error'):
            with self.subTest(child=child), self.assertRaises(ValueError):
                self.run_report(self.report().replace('/>', f'><{child}/></testcase>', 1))

    def test_missing_or_duplicate_cases_and_wrong_source_rejected(self):
        for data in ('<testsuites/>', self.report().replace('test_explicit_rollback_time_is_not_overridden_after_control', 'test_default_clock_is_sampled_after_control_acquisition', 1)):
            with self.subTest(data=data), self.assertRaises(ValueError): self.run_report(data)
        with self.assertRaises(ValueError): self.run_report(self.report(), 'main')

    def test_required_module_cannot_be_replaced_by_other_checks(self):
        with self.assertRaises(ValueError):
            self.run_report(self.report().replace('test_stage18_queue_redis', 'unrelated_tests'))

    def test_required_counts_match_independent_executed_case_inventory(self):
        self.assertEqual(REQUIRED_MODULES, {
            module: len(cases) for module, cases in EXECUTED_CASES.items()})
        self.assertEqual(sum(map(len, EXECUTED_CASES.values())), 23)

    def test_missing_and_extra_required_cases_rejected_for_every_module(self):
        for module, cases in EXECUTED_CASES.items():
            for mode in ('missing', 'extra'):
                with self.subTest(module=module, mode=mode):
                    root = ET.fromstring(self.report())
                    suite = root.find('testsuite')
                    classname, name = cases[0]
                    if mode == 'missing':
                        case = next(c for c in suite if c.get('name') == name)
                        suite.remove(case)
                    else:
                        ET.SubElement(suite, 'testcase', classname=classname, name='unexpected_case')
                    with self.assertRaisesRegex(ValueError, 'Required module count mismatch: '+module):
                        self.run_report(ET.tostring(root, encoding='unicode'))

    def test_previous_four_and_ten_case_inventory_rejected(self):
        root = ET.fromstring(self.report())
        suite = root.find('testsuite')
        for module, old_count in [('test_stage18_migrations_postgres', 4),
                                  ('test_stage18_migration_invariants', 10)]:
            matches = [c for c in suite if module in c.get('classname').split('.')]
            for case in matches[old_count:]:
                suite.remove(case)
        with self.assertRaises(ValueError):
            self.run_report(ET.tostring(root, encoding='unicode'))

    def test_receipt_binds_exact_payload_and_source_without_acceptance_claim(self):
        data = self.report()
        sha = 'b'*40
        receipt = self.run_report(data, sha)
        self.assertEqual(receipt['source_sha'], sha)
        self.assertEqual(receipt['junit_sha256'], hashlib.sha256(data.encode()).hexdigest())
        self.assertEqual(receipt['module_counts'], REQUIRED_MODULES)
        self.assertEqual(receipt['skipped'], 0)
        self.assertEqual(receipt['kind'], 'junit_consistency_only')
        self.assertFalse(receipt['real_provider_certification'])
