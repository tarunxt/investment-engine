from datetime import timedelta
from dataclasses import replace
import pytest
from sqlalchemy import select,func
from app.domains.ai_limits.contracts import BoundaryDenied
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.public_service.signup_perimeter import SignupPerimeter,SignupPerimeterPolicy,ChallengeVerifier,VerifiedChallenge,TOPIC
from test_stage17_reviewed_residency import setup,NOW

class FixtureVerifier(ChallengeVerifier):
    def __init__(self):self.calls=[];self.change={}
    def verify(self,token,*,peer,now):
        self.calls.append((token,peer))
        if not token.startswith('fixture-'):raise RuntimeError('unverified synthetic token')
        return replace(VerifiedChallenge(token,'signup.example.invalid','signup',NOW),**self.change)

def perimeter():
    return SignupPerimeter(policy=SignupPerimeterPolicy('synthetic-not-live-enrollment','signup.example.invalid',2,120,b'x'*32),verifier=FixtureVerifier())

def admit(p,db,token='fixture-one',**kw):
    args=dict(peer='192.0.2.1',now=NOW);args.update(kw)
    return p.admit(db,'fixture@example.invalid',token,**args)

def test_unbound_rejects_and_no_boolean_proof(setup):
    db,_=setup
    with pytest.raises(BoundaryDenied):admit(SignupPerimeter(),db)
    p=perimeter();p.verifier=True
    with pytest.raises(BoundaryDenied):admit(p,db)

def test_transactional_consume_replay_and_rollback(setup):
    db,_=setup;p=perimeter();identity=admit(p,db);db.rollback()
    assert admit(p,db)==identity;db.commit()
    with pytest.raises(BoundaryDenied,match='REPLAY'):admit(p,db)
    assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC))==1
    payload=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)).payload
    assert 'fixture@example.invalid' not in str(payload) and '192.0.2.1' not in str(payload) and 'fixture-one' not in str(payload)

@pytest.mark.parametrize('change',[{'hostname':'foreign.example.invalid'},{'action':'reset'}, {'issued_at':NOW+timedelta(seconds=1)}, {'issued_at':NOW-timedelta(seconds=121)}])
def test_wrong_or_stale_challenge_rejected_before_admission(setup,change):
    db,_=setup;p=perimeter();p.verifier.change=change
    with pytest.raises(BoundaryDenied):admit(p,db)
    assert db.scalar(select(func.count()).select_from(OutboxMessage))==0

@pytest.mark.parametrize('header',[b'forwarded',b'X-Forwarded-For',b'x-real-ip'])
def test_no_unapproved_proxy_trust(setup,header):
    db,_=setup;p=perimeter()
    with pytest.raises(BoundaryDenied,match='PROXY'):admit(p,db,headers=[(header,b'198.51.100.1')])
    assert not p.verifier.calls

def test_transport_validation_and_verifier_failure(setup):
    db,_=setup;p=perimeter()
    with pytest.raises(BoundaryDenied):admit(p,db,peer='not-an-ip')
    with pytest.raises(BoundaryDenied,match='REJECTED'):admit(p,db,token='forged')
    assert db.scalar(select(func.count()).select_from(OutboxMessage))==0

def test_network_quota_independent_and_existing_identity_quota_preserved(setup):
    db,_=setup;p=perimeter();admit(p,db);db.commit();admit(p,db,'fixture-two');db.commit()
    with pytest.raises(BoundaryDenied,match='NETWORK'):admit(p,db,'fixture-three')
    db.rollback();admit(p,db,'fixture-three',peer='192.0.2.2');db.commit()
    with pytest.raises(BoundaryDenied,match='QUOTA'):admit(p,db,'fixture-four',peer='192.0.2.3')

def test_challenge_replay_stays_consumed_after_network_hash_key_rotation(setup):
    db,_=setup;p=perimeter();admit(p,db);db.commit()
    p.policy=replace(p.policy,hash_key=b'y'*32)
    with pytest.raises(BoundaryDenied,match='REPLAY'):admit(p,db)
