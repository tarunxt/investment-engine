"""Completion gates, legacy preferences, transactional dispatch and mail routing."""
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

from app.domains.mails.completion_events import (
    SESSION_KEY, bullpen_completion_payloads, record_bullpen_completions,
    dispatch_committed_completions, discard_rolled_back_completions,
)
from app.domains.mails.completion_preferences import (
    COMPLETION_CATALOG, COMPLETION_DEFAULTS, inherit_legacy_preferences, stock_run_preference,
)
from app.domains.mails.tasks import build_completion_email


def scan(count=65):
    return {
        "id": "scan-123", "status": "running", "completed_at": None,
        "stage_results": [{
            "stage_number": 1, "status": "pass", "reason": "Scan complete",
            "completed_at": "2026-09-10T01:02:16Z",
            "outputs": {"phase_status": "completed", "workflow_stage_key": "scan",
                        "scan_completeness": "complete", "accepted_candidates_count": count},
        }],
    }


def test_all_platform_stages_and_overall_exist():
    assert len(COMPLETION_CATALOG) == 18
    assert len({item['key'] for item in COMPLETION_CATALOG}) == 18
    assert COMPLETION_DEFAULTS['completion.bullpen.scan'] is True
    assert COMPLETION_DEFAULTS['completion.bullpen.llm'] is False


def test_legacy_off_does_not_disable_new_bullpen_default():
    prefs = dict(COMPLETION_DEFAULTS)
    inherit_legacy_preferences(prefs, {'run_completion': False, 'auto_rebalance_success': False})
    assert prefs['completion.bullpen.scan']
    assert not prefs['completion.zerodha.overall']


def test_explicit_child_beats_legacy_switch():
    prefs = dict(COMPLETION_DEFAULTS)
    saved = {'run_completion': True, 'completion.zerodha.threats': False}
    inherit_legacy_preferences(prefs, saved)
    prefs.update(saved)
    assert not prefs['completion.zerodha.threats']
    assert prefs['completion.indmoney.technical']


def test_stage_one_emits_while_overall_and_stage_two_not_complete():
    assert list(bullpen_completion_payloads(scan())) == ['scan']
    assert bullpen_completion_payloads(scan())['scan']['filtered_count'] == 65


def test_empty_completed_scan_is_valid():
    assert bullpen_completion_payloads(scan(0))['scan']['filtered_count'] == 0


def test_incomplete_loading_and_unidentified_scan_do_not_trigger():
    for key, value in [('phase_status', 'working'), ('scan_completeness', 'incomplete'),
                       ('accepted_candidates_count', None), ('workflow_stage_key', None)]:
        payload = scan()
        payload['stage_results'][0]['outputs'][key] = value
        assert bullpen_completion_payloads(payload) == {}


def test_stage_three_and_overall_have_independent_events():
    payload = scan()
    stage = deepcopy(payload['stage_results'][0])
    stage.update(stage_number=3)
    stage['outputs'] = {'phase_status': 'completed', 'workflow_stage_key': 'invest'}
    payload['stage_results'].append(stage)
    payload.update(status='completed', completed_at='2026-09-10T01:05:00Z')
    assert set(bullpen_completion_payloads(payload)) == {'scan', 'invest', 'overall'}


def test_repeated_progress_does_not_duplicate_event():
    session = SimpleNamespace(add=Mock(), info={})
    record_bullpen_completions(session, user_id=1, previous=scan(), current=scan())
    session.add.assert_not_called()
    record_bullpen_completions(session, user_id=1, previous={}, current=scan())
    session.add.assert_called_once()
    assert len(session.info[SESSION_KEY]) == 1


def test_rollback_does_not_dispatch(monkeypatch):
    task = Mock()
    monkeypatch.setattr('app.domains.mails.tasks.deliver_completion_email.delay', task)
    session = SimpleNamespace(info={SESSION_KEY: [SimpleNamespace(id=14)]})
    discard_rolled_back_completions(session)
    dispatch_committed_completions(session)
    task.assert_not_called()


def test_commit_dispatch_and_broker_failure_leave_durable_event(monkeypatch):
    task = Mock(side_effect=RuntimeError('broker unavailable'))
    monkeypatch.setattr('app.domains.mails.tasks.deliver_completion_email.delay', task)
    session = SimpleNamespace(info={SESSION_KEY: [SimpleNamespace(id=14)]})
    dispatch_committed_completions(session)
    task.assert_called_once_with(14)
    assert SESSION_KEY not in session.info


def test_trigger_email_contains_exact_subject_and_scan_identity():
    data = bullpen_completion_payloads(scan())['scan']
    data['summary'] = '<script>bad</script>'
    subject, html, text = build_completion_email(data)
    assert subject == 'Cred-X: Bullpen Stage 1 completed'
    assert 'Run ID: scan-123' in text
    assert 'Events that passed Filters: 65' in text
    assert '<script>' not in html
    assert '/console/bullpen-ai/history' in text


def test_stock_routing_respects_platform_and_stage():
    run = SimpleNamespace(auto_rebalance_portfolio='us', auto_rebalance_label='Test (Technical Scan)', prompt='')
    assert stock_run_preference(run) == 'completion.indmoney.technical'
    run.auto_rebalance_portfolio = 'india'
    run.auto_rebalance_label = 'Test (Threats Scan)'
    assert stock_run_preference(run) == 'completion.zerodha.threats'
