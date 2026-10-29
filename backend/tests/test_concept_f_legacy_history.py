"""Bounded owner-scoped legacy history discovery; synthetic SQL/HTTP only."""
import pytest
from test_private_api_ownership import private_api
from app.domains.runs.models import AutoRebalanceWorkflow


@pytest.mark.parametrize('portfolio', ['india', 'indmoney_us'])
def test_workflow_history_does_not_hide_older_run_or_standalone_job_sequences(private_api, portfolio):
    a = private_api; owner = a.users[0].id
    a.session.add(AutoRebalanceWorkflow(user_id=owner, portfolio=portfolio, sequence=1,
        label='Synthetic workflow', status='queued', current_stage='sync'))
    a.runs[0].auto_rebalance_portfolio = portfolio; a.runs[0].auto_rebalance_sequence = 90
    a.jobs[1].auto_rebalance_portfolio = portfolio; a.jobs[1].auto_rebalance_sequence = 91
    a.jobs[3].auto_rebalance_portfolio = portfolio; a.jobs[3].auto_rebalance_sequence = 999
    a.session.commit()
    path = '/runs/auto-rebalance-history'
    response = a.client.get(path, params={'portfolio': portfolio}, headers=a.headers[0])
    assert response.status_code == 200, response.text
    assert [item['sequence'] for item in response.json()['items']] == [91, 90, 1]
    bounded = a.client.get(path, params={'portfolio': portfolio, 'limit': 1}, headers=a.headers[0])
    assert [item['sequence'] for item in bounded.json()['items']] == [91]
    assert a.client.get(f'{path}/{portfolio}/999', headers=a.headers[0]).status_code == 404
