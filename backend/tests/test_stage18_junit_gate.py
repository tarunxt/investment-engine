import hashlib
import xml.etree.ElementTree as ET
import tempfile
from pathlib import Path
import unittest
from scripts.public_launch.stage18_junit_gate import verify, REQUIRED_MODULES, REQUIRED_CASES


# Independent named-case inventory retained from the passing ae154287 rehearsal:
# source ae15428776d54e0abbc379c8fe63be4e17a5797d, artifact 12503200984,
# XML SHA-256 24b1cf37822b1b27eb2ef0e1ccfe92a926251334e83dceb0c37d990f7123b870.
# This synthetic report is a gate regression fixture, not execution evidence.
# Keep nine top-level gate tests: the selected cohort includes this file itself.
EXECUTED_CLASS_CASES = {'backend.tests.test_stage18_migration_invariants.MigrationInvariants': ['test_closed_projection_rejects_credentials_boolean_ids_and_orphans',
                                                                         'test_failed_transaction_snapshot_must_roll_back_all_partial_changes',
                                                                         'test_foreign_connection_copy_history_move_or_order_approval_rejected',
                                                                         'test_legacy_and_google_account_ids_roles_disabled_status_preserved',
                                                                         'test_new_account_optional_module_or_admin_grant_rejected',
                                                                         'test_pending_incompatible_work_or_rebinding_rejected',
                                                                         'test_preservation_new_defaults_quarantine_and_counts',
                                                                         'test_repeated_initialization_snapshot_has_stable_per_owner_counts',
                                                                         'test_unknown_roles_and_connection_modes_reject',
                                                                         'test_unresolved_ownership_never_assigned_to_logged_in_owner'],
 'backend.tests.test_stage18_migration_invariants.CheckRenderingInvariants': ['test_changed_constraint_semantics_remain_different',
                                                                              'test_only_known_lossless_array_cast_rendering_is_equivalent',
                                                                              'test_unsupported_sql_is_preserved_exactly'],
 'backend.tests.test_stage18_junit_gate.JunitGate': ['test_actual_pytest_unittest_classnames_keep_module_identity',
                                                     'test_complete_execution_receipt_is_not_full_acceptance',
                                                     'test_missing_and_extra_required_cases_rejected_for_every_module',
                                                     'test_missing_or_duplicate_cases_and_wrong_source_rejected',
                                                     'test_previous_four_and_ten_case_inventory_rejected',
                                                     'test_receipt_binds_exact_payload_and_source_without_acceptance_claim',
                                                     'test_required_counts_match_independent_executed_case_inventory',
                                                     'test_required_module_cannot_be_replaced_by_other_checks',
                                                     'test_skips_xfail_failures_and_collection_errors_rejected'],
 'backend.tests.test_stage18_postgres_tools.PostgresTools': ['test_bookworm_default_pg15_client_rejected',
                                                             'test_mixed_client_versions_rejected',
                                                             'test_official_debian_pg16_clients_match_server16',
                                                             'test_unreviewed_server_and_boolean_rejected',
                                                             'test_wrong_tool_multiline_or_malformed_identity_rejected'],
 'backend.tests.test_stage18_signup_clock': ['test_default_clock_is_sampled_after_control_acquisition',
                                             'test_explicit_rollback_time_is_not_overridden_after_control'],
 'backend.tests.test_stage18_asgi_load': ['test_bounded_signed_owner_other_admin_and_anonymous_asgi_load'],
 'backend.tests.test_stage18_migrations_postgres': ['test_actual_multiuser_migration_idempotence_and_connection_ownership',
                                                    'test_actual_failed_migration_transaction_restores_schema_rows_and_revision',
                                                    'test_actual_pg_dump_restore_preserves_every_fixture_row_and_sequence',
                                                    'test_actual_concurrent_google_signup_preserves_independent_defaults',
                                                    'test_actual_check_cast_forms_preserve_constraint_semantics[value::text '
                                                    "= ANY (ARRAY['user_owned'::character varying, "
                                                    "'platform_managed'::character varying]::text[])]",
                                                    'test_actual_check_cast_forms_preserve_constraint_semantics[value::text '
                                                    "= ANY (ARRAY['user_owned'::character varying::text, "
                                                    "'platform_managed'::character varying::text])]"],
 'backend.tests.test_stage18_queue_redis': ['test_actual_redis_redelivery_preserves_bound_owner_version_and_task_id'],
 'backend.tests.test_google_signin': ['test_verified_google_identity',
                                      'test_rejects_untrusted_claims[override0]',
                                      'test_rejects_untrusted_claims[override1]',
                                      'test_rejects_untrusted_claims[override2]',
                                      'test_rejects_untrusted_claims[override3]',
                                      'test_rejects_untrusted_claims[override4]',
                                      'test_rejects_untrusted_claims[override5]',
                                      'test_rejects_untrusted_claims[override6]',
                                      'test_rejects_untrusted_claims[override7]',
                                      'test_rejects_forged_token_and_missing_configuration',
                                      'test_rejects_unknown_inactive_and_ambiguous_accounts[matches0]',
                                      'test_rejects_unknown_inactive_and_ambiguous_accounts[matches1]',
                                      'test_rejects_unknown_inactive_and_ambiguous_accounts[matches2]',
                                      'test_preserves_existing_account_and_role',
                                      'test_client_id_override_does_not_read_database',
                                      'test_default_client_is_independent_of_sheets',
                                      'test_recovery_allows_only_required_google_routes',
                                      'test_new_google_profiles_are_independent_and_reused',
                                      'test_concurrent_signup_reuses_winner'],
 'backend.tests.test_stage17_closure': ['test_signup_limits_are_durable_independent_of_ai_budget',
                                        'test_signup_rollback_does_not_consume_account_creation_slot',
                                        'test_two_signup_writers_one_global_admission',
                                        'test_signup_preserves_clock_and_boundaries',
                                        'test_reviewed_residency_is_synthetic_only_owner_bound_and_revocable',
                                        'test_residency_adversarial_evidence[owner]',
                                        'test_residency_adversarial_evidence[ciphertext]',
                                        'test_residency_adversarial_evidence[expiry]',
                                        'test_residency_adversarial_evidence[nonindia]',
                                        'test_full_synthetic_export_covers_all_declared_datasets_without_credentials',
                                        'test_deletion_retention_hold_and_owned_counts_are_durable',
                                        'test_full_account_contract_fails_closed[missing_category]',
                                        'test_full_account_contract_fails_closed[foreign_owner]',
                                        'test_full_account_contract_fails_closed[unreviewed]',
                                        'test_support_exact_consent_role_revocation_and_audit',
                                        'test_support_cannot_expand_authority[expiry]',
                                        'test_support_cannot_expand_authority[wrong_scope]',
                                        'test_support_cannot_expand_authority[lost_role]',
                                        'test_support_cannot_expand_authority[cost_reader]',
                                        'test_support_audit_failure_returns_no_data',
                                        'test_monitor_reads_owned_actual_state_and_records_deduplicated_local_alert',
                                        'test_private_routes_enforce_completed_owned_export_and_audited_support'],
 'backend.tests.test_stage06_modules': ['test_exact_registry_and_dependency_graph_validation',
                                        'test_config_schema_is_typed_and_cannot_confer_authority[bad0]',
                                        'test_config_schema_is_typed_and_cannot_confer_authority[bad1]',
                                        'test_config_schema_is_typed_and_cannot_confer_authority[bad2]',
                                        'test_module_contract_requires_current_active_owner[GET-/me/modules-None]',
                                        'test_module_contract_requires_current_active_owner[PATCH-/me/modules-body1]',
                                        'test_module_contract_requires_current_active_owner[POST-/me/modules/disable-impact-body2]',
                                        'test_new_and_existing_accounts_default_to_no_modules_without_get_writes',
                                        'test_atomic_multi_update_stale_conflict_and_owner_separation',
                                        'test_body_identity_and_authority_overrides_are_rejected[extra0]',
                                        'test_body_identity_and_authority_overrides_are_rejected[extra1]',
                                        'test_body_identity_and_authority_overrides_are_rejected[extra2]',
                                        'test_body_identity_and_authority_overrides_are_rejected[extra3]',
                                        'test_unknown_invalid_duplicate_updates_never_partially_commit[updates0]',
                                        'test_unknown_invalid_duplicate_updates_never_partially_commit[updates1]',
                                        'test_unknown_invalid_duplicate_updates_never_partially_commit[updates2]',
                                        'test_unknown_invalid_duplicate_updates_never_partially_commit[updates3]',
                                        'test_unavailable_module_rejects_entire_patch_and_uat2_stays_closed',
                                        'test_dependency_validation_and_disable_preview_are_atomic_and_read_only',
                                        'test_existing_empty_version_zero_header_can_be_updated',
                                        'test_corrupt_module_state_is_closed_without_secret_details[unknown_module]',
                                        'test_corrupt_module_state_is_closed_without_secret_details[invalid_config]',
                                        'test_corrupt_module_state_is_closed_without_secret_details[future_version]',
                                        'test_shared_policy_is_owner_bound_current_and_never_entitles_selection[http]',
                                        'test_shared_policy_is_owner_bound_current_and_never_entitles_selection[stream]',
                                        'test_shared_policy_is_owner_bound_current_and_never_entitles_selection[worker]',
                                        'test_shared_policy_is_owner_bound_current_and_never_entitles_selection[side_effect]',
                                        'test_internal_analysis_does_not_require_standalone_ui_and_core_stays_available',
                                        'test_unknown_or_malformed_server_facts_fail_closed',
                                        'test_core_account_access_survives_corrupt_optional_state',
                                        'test_response_or_audit_failure_rolls_back_complete_selection_transaction',
                                        'test_google_first_and_repeat_login_leave_optional_modules_default_denied',
                                        'test_failed_first_google_transaction_cannot_leave_optional_records',
                                        'test_entitlement_and_connection_axes_remain_independent[facts0-JURISDICTION_NOT_ENTITLED]',
                                        'test_entitlement_and_connection_axes_remain_independent[facts1-PLAN_NOT_ENTITLED]',
                                        'test_entitlement_and_connection_axes_remain_independent[facts2-CONNECTION_NOT_READY]',
                                        'test_disable_preview_includes_transitive_dependencies_without_changes',
                                        'test_unknown_catalogue_capability_cannot_be_registered'],
 'backend.tests.test_stage07_lifecycle': ['test_disable_atomic_outbox_cancel_running_and_foreign_owner',
                                          'test_fresh_checkpoints_stop_running_fake_work_and_never_reenable_old_work',
                                          'test_missed_event_and_reordered_duplicate_events_use_current_state',
                                          'test_unrelated_module_toggle_does_not_invalidate_current_analysis',
                                          'test_no_context_recovery_override_or_stale_payload_can_authorize_effect',
                                          'test_routes_have_explicit_core_history_and_new_work_classification',
                                          'test_reenable_does_not_resume_schedules_but_explicit_resume_dispatches_nothing',
                                          'test_global_financial_override_cannot_turn_analysis_context_into_order_permission',
                                          'test_actual_optional_route_matrix_only_narrow_stops_reconciliation_are_safety',
                                          'test_real_provider_and_sheet_adapters_deny_unbound_calls_before_clients',
                                          'test_accepted_order_reconciliation_marker_never_allows_submit_or_liquidation',
                                          'test_disable_cancels_owned_parent_workflow_without_rewriting_completed_history',
                                          'test_generic_dispatch_locator_is_persisted_versioned_and_not_payload_authority',
                                          'test_disable_cancels_queued_generic_binding_and_reenable_does_not_rebind',
                                          'test_malformed_consumer_cannot_select_a_module[portfolio0]',
                                          'test_malformed_consumer_cannot_select_a_module[portfolio1]',
                                          'test_malformed_consumer_cannot_select_a_module[True]',
                                          'test_malformed_consumer_cannot_select_a_module[7]',
                                          'test_financial_order_routes_require_execution_not_analysis',
                                          'test_actual_cli_spawn_waits_for_fresh_fence_and_holds_it_through_start',
                                          'test_actual_cli_spawn_denied_by_final_fence_never_creates_process'],
 'backend.tests.test_stage09_connections_postgres': ['test_two_writers_one_current_connection',
                                                     'test_rotation_cas_one_winner_preserves_bound_token',
                                                     'test_disable_and_rotation_serialize_without_resurrecting_token',
                                                     'test_actual_additive_migration_roundtrip_preserves_legacy_ciphertext'],
 'backend.tests.test_stage17_disposable_consumer_services': ['test_actual_authenticated_admission_and_child_worker_reject_changed_authority[foreign]',
                                                             'test_actual_authenticated_admission_and_child_worker_reject_changed_authority[module]',
                                                             'test_actual_authenticated_admission_and_child_worker_reject_changed_authority[connection]',
                                                             'test_actual_authenticated_admission_and_child_worker_reject_changed_authority[approval]'],
 'backend.tests.test_stage17_application_composition_postgres': ['test_actual_pg_authenticated_export_replay_and_foreign_result_denial',
                                                                 'test_actual_pg_authenticated_cancellation_partial_disposal_and_foreign_preservation',
                                                                 'test_actual_pg_reviewed_residency_changes_only_jurisdiction_and_revocation_denies']}
EXECUTED_CASES = {}
for classname, names in EXECUTED_CLASS_CASES.items():
    module = next(part for part in classname.split('.') if part.startswith('test_'))
    EXECUTED_CASES.setdefault(module, []).extend((classname, name) for name in names)


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
        self.assertEqual(report['executed'], 148)
        self.assertFalse(report['full_release_verified'])
        self.assertFalse(report['browser_load_verified'])
        root = ET.fromstring(self.report())
        root.find('testsuite').attrib.update(tests='205', failures='0', errors='0', skipped='0')
        self.assertEqual(self.run_report(ET.tostring(root, encoding='unicode'))['executed'], 148)

    def test_actual_pytest_unittest_classnames_keep_module_identity(self):
        self.assertEqual(self.run_report(self.report())['executed'], 148)
        root = ET.fromstring(self.report())
        for case in root.findall('.//testcase'):
            module = next(part for part in case.get('classname').split('.')
                          if part.startswith('test_'))
            case.set('classname', module)
        self.assertEqual(self.run_report(ET.tostring(root, encoding='unicode'))['executed'], 148)

    def test_skips_xfail_failures_and_collection_errors_rejected(self):
        for module, cases in EXECUTED_CASES.items():
            for child in ('skipped', 'failure', 'error'):
                with self.subTest(module=module, child=child):
                    root = ET.fromstring(self.report())
                    classname, name = cases[0]
                    case = next(c for c in root.findall('.//testcase')
                                if c.get('classname') == classname and c.get('name') == name)
                    ET.SubElement(case, child)
                    with self.assertRaises(ValueError):
                        self.run_report(ET.tostring(root, encoding='unicode'))
        # Collection and suite-level error markers are not passing cases either.
        for child in ('skipped', 'failure', 'error'):
            with self.subTest(suite_marker=child):
                root = ET.fromstring(self.report())
                ET.SubElement(root.find('testsuite'), child)
                with self.assertRaises(ValueError):
                    self.run_report(ET.tostring(root, encoding='unicode'))
        for target in ('testsuites', 'testsuite'):
            for attribute in ('failures', 'errors', 'skipped', 'failure', 'error'):
                for value in ('1', '-1', '0.0', '', 'false', ' 0', '+0', '00', 'NaN'):
                    with self.subTest(target=target, attribute=attribute, value=value):
                        root = ET.fromstring(self.report())
                        suite = root if target == 'testsuites' else root.find('testsuite')
                        suite.set(attribute, value)
                        with self.assertRaisesRegex(ValueError, 'suite result summary'):
                            self.run_report(ET.tostring(root, encoding='unicode'))
        # A testsuite can itself be the document root; check its attributes too.
        root = ET.fromstring(self.report()).find('testsuite')
        root.set('failures', '1')
        with self.assertRaisesRegex(ValueError, 'suite result summary'):
            self.run_report(ET.tostring(root, encoding='unicode'))

    def test_missing_or_duplicate_cases_and_wrong_source_rejected(self):
        for data in ('<testsuites/>', self.report().replace('test_explicit_rollback_time_is_not_overridden_after_control', 'test_default_clock_is_sampled_after_control_acquisition', 1)):
            with self.subTest(data=data), self.assertRaises(ValueError): self.run_report(data)
        with self.assertRaises(ValueError): self.run_report(self.report(), 'main')
        for module, cases in EXECUTED_CASES.items():
            for mutation in ('name', 'classname'):
                with self.subTest(module=module, mutation=mutation):
                    root = ET.fromstring(self.report())
                    classname, name = cases[0]
                    case = next(c for c in root.findall('.//testcase')
                                if c.get('classname') == classname and c.get('name') == name)
                    case.set(mutation, 'test_substituted_case' if mutation == 'name'
                             else 'backend.tests.'+module+'.UnreviewedClass')
                    with self.assertRaisesRegex(ValueError, 'Exact selected case identity mismatch'):
                        self.run_report(ET.tostring(root, encoding='unicode'))

    def test_required_module_cannot_be_replaced_by_other_checks(self):
        # In particular, Google and inherited Stage06/07/09/17 regressions used
        # to be optional to the gate even though the workflow selected them.
        for module in EXECUTED_CASES:
            with self.subTest(missing_module=module):
                root = ET.fromstring(self.report())
                suite = root.find('testsuite')
                for case in list(suite):
                    if module in case.get('classname').split('.'):
                        suite.remove(case)
                with self.assertRaisesRegex(ValueError, 'Required module count mismatch: '+module):
                    self.run_report(ET.tostring(root, encoding='unicode'))
        with self.assertRaises(ValueError):
            self.run_report(self.report().replace('test_stage18_queue_redis', 'unrelated_tests'))
        root = ET.fromstring(self.report())
        ET.SubElement(root.find('testsuite'), 'testcase',
                      classname='backend.tests.test_unselected_module', name='test_unselected')
        with self.assertRaisesRegex(ValueError, 'Unexpected selected module'):
            self.run_report(ET.tostring(root, encoding='unicode'))

    def test_required_counts_match_independent_executed_case_inventory(self):
        self.assertEqual(REQUIRED_MODULES, {
            module: len(cases) for module, cases in EXECUTED_CASES.items()})
        self.assertEqual(sum(map(len, EXECUTED_CASES.values())), 148)
        self.assertEqual(REQUIRED_CASES,
                         {(classname, name) for cases in EXECUTED_CASES.values()
                          for classname, name in cases})

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
