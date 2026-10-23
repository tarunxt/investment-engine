"""Deterministic default-clock/fence regression; real DB race is separate."""
from datetime import datetime,timedelta,timezone
from types import SimpleNamespace
import pytest
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.public_service import signup


def scenario(monkeypatch):
    start=datetime(2026,10,23,tzinfo=timezone.utc)
    clock={'at':start,'fenced':False};observed=[]
    row=SimpleNamespace(payload={'events':[{'at':(start+timedelta(seconds=1)).isoformat(),
                                           'identity':'existing-synthetic-identity'}]})
    class Clock(datetime):
        @classmethod
        def now(cls,tz=None):
            observed.append(clock['fenced']);return clock['at']
    def control(db,name):
        assert name=='signup';clock.update(at=start+timedelta(seconds=2),fenced=True);return row
    monkeypatch.setattr(signup,'datetime',Clock);monkeypatch.setattr(signup,'control',control)
    db=SimpleNamespace(flush=lambda:None)
    return start,db,row,observed


def test_default_clock_is_sampled_after_control_acquisition(monkeypatch):
    start,db,row,observed=scenario(monkeypatch)
    signup.admit(db,'synthetic-next@example.invalid')
    assert observed==[True]
    assert len(row.payload['events'])==2
    assert row.payload['events'][-1]['at']==(start+timedelta(seconds=2)).isoformat()


def test_explicit_rollback_time_is_not_overridden_after_control(monkeypatch):
    start,db,row,observed=scenario(monkeypatch)
    with pytest.raises(BoundaryDenied,match='SIGNUP_CLOCK_ROLLBACK'):
        signup.admit(db,'synthetic-next@example.invalid',now=start)
    assert observed==[] and len(row.payload['events'])==1
