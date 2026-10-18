"""Sanitized repair regressions: no host identities, endpoints or host operations."""
from ipaddress import IPv4Address
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
from nft_sets import render_ipv4_set
from stop_jobs import wait_stop_jobs_settled

class NftSetTests(unittest.TestCase):
    def test_empty_set_is_a_declaration_without_empty_elements_clause(self):
        self.assertEqual(render_ipv4_set('acme4', []), 'set acme4 { type ipv4_addr; }')
    def test_nonempty_set_preserves_canonical_element(self):
        fixture = str(IPv4Address(1))  # Local rendering fixture, no network operation.
        self.assertEqual(render_ipv4_set('tls4', [fixture]),
                         'set tls4 { type ipv4_addr; elements = { ' + fixture + ' }; }')
    def test_names_duplicates_and_injected_elements_fail_closed(self):
        fixture = str(IPv4Address(1))
        for name, values in [('other', []), ('tls4', [fixture, fixture]),
                             ('acme4', ['invalid; accept']), ('acme4', [True]),
                             ('tls4', tuple())]:
            with self.subTest(name=name, values=values), self.assertRaises(ValueError):
                render_ipv4_set(name, values)

class StopJobTests(unittest.TestCase):
    def runner(self, states, jobs):
        states, jobs = iter(states), iter(jobs)
        return Mock(side_effect=lambda args, **kw: SimpleNamespace(
            returncode=0, stdout=next(states) if args[1] == 'show' else next(jobs)))
    def test_waits_after_pid_exit_until_failstop_and_pending_jobs_settle(self):
        run = self.runner(['deactivating', 'inactive', 'inactive'],
                          ['1 credx-uat-backend.service stop running',
                           '2 credx-uat-backend.service stop running', ''])
        wait_stop_jobs_settled(run, sleep=Mock())
        self.assertEqual(run.call_count, 6)
    def test_unrelated_jobs_do_not_block_or_mutate(self):
        run = self.runner(['inactive'], ['1 unrelated.service stop running'])
        wait_stop_jobs_settled(run)
        self.assertTrue(all(c.args[0][1] in ('show', 'list-jobs') for c in run.call_args_list))
    def test_failed_state_read_never_allows_progress(self):
        run = Mock(return_value=SimpleNamespace(returncode=1, stdout=''))
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            wait_stop_jobs_settled(run)
    def test_pending_restart_is_bounded_and_never_restarts_itself(self):
        run = self.runner(['inactive'], ['2 credx-uat-backend.service restart running'])
        with self.assertRaisesRegex(ValueError, 'not settled'):
            wait_stop_jobs_settled(run, clock=Mock(side_effect=[0, 0, 21]), sleep=Mock())
        self.assertTrue(all(c.args[0][1] in ('show', 'list-jobs') for c in run.call_args_list))
    def test_unknown_state_is_not_treated_as_stopped(self):
        run = self.runner(['unknown'], [''])
        with self.assertRaisesRegex(ValueError, 'not settled'):
            wait_stop_jobs_settled(run, clock=Mock(side_effect=[0, 0, 1, 21]), sleep=Mock())
