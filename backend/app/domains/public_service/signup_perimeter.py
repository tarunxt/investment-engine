"""Disabled transactional signup perimeter; no CAPTCHA enrolment or proxy trust.

Server composition must explicitly provide a reviewed verifier and independent
hash key. Transport peer addresses only; forwarded client identities are refused
until a separately reviewed proxy adapter exists. This admission must share the
account-creation transaction; it never issues sessions or creates accounts.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from ipaddress import ip_address
import hashlib, hmac
from sqlalchemy import select
from uuid import uuid5, NAMESPACE_URL
from app.domains.ai_limits.contracts import BoundaryDenied, utc
from app.infrastructure.database.outbox.models import OutboxMessage
from .store import control
from .signup import admit, SignupLimits

TOPIC = 'public_service.signup.challenge.v1'

@dataclass(frozen=True)
class VerifiedChallenge:
    reference: str
    hostname: str
    action: str
    issued_at: datetime

class ChallengeVerifier(ABC):
    """Trusted server-owned adapter. No environment-selected default/fallback.

    A real implementation must validate issuer signature, account/hostname,
    action, expiry and remote response; a caller boolean is never sufficient.
    """
    @abstractmethod
    def verify(self, token, *, peer, now): raise NotImplementedError

@dataclass(frozen=True)
class SignupPerimeterPolicy:
    reference: str = ''
    hostname: str = ''
    per_network_hour: int = 3
    max_age_seconds: int = 120
    hash_key: bytes = field(default=b'', repr=False)

    def validate(self):
        if (type(self.reference) is not str or not 3 <= len(self.reference) <= 120
            or type(self.hostname) is not str or not 3 <= len(self.hostname) <= 253
            or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789.-' for c in self.hostname)
            or type(self.per_network_hour) is not int or not 1 <= self.per_network_hour <= 128
            or type(self.max_age_seconds) is not int or not 1 <= self.max_age_seconds <= 300
            or type(self.hash_key) is not bytes or len(self.hash_key) < 32):
            raise BoundaryDenied('SIGNUP_PERIMETER_UNBOUND')
        return self

class SignupPerimeter:
    def __init__(self, *, policy=None, verifier=None): self.policy, self.verifier = policy, verifier

    def admit(self, db, email, token, *, peer, headers=(), now=None, limits=SignupLimits()):
        now = utc(now or datetime.now(timezone.utc))
        if type(self.policy) is not SignupPerimeterPolicy or not isinstance(self.verifier, ChallengeVerifier):
            raise BoundaryDenied('SIGNUP_PERIMETER_UNBOUND')
        p = self.policy.validate()
        # No selection of an unreviewed live proxy topology. Reject spoofable
        # forwarding inputs instead of trusting the leftmost X-Forwarded-For.
        if any(k.lower() in {b'forwarded', b'x-forwarded-for', b'x-real-ip'} for k, _ in headers):
            raise BoundaryDenied('SIGNUP_PROXY_BINDING_REQUIRED')
        try: peer = str(ip_address(peer))
        except (ValueError, TypeError): raise BoundaryDenied('SIGNUP_TRANSPORT_PEER_REQUIRED') from None
        if type(token) is not str or not 1 <= len(token) <= 4096:
            raise BoundaryDenied('SIGNUP_CHALLENGE_REQUIRED')
        try: proof = self.verifier.verify(token, peer=peer, now=now)
        except Exception: raise BoundaryDenied('SIGNUP_CHALLENGE_REJECTED') from None
        if (type(proof) is not VerifiedChallenge or proof.hostname != p.hostname or proof.action != 'signup'
            or type(proof.reference) is not str or not 1 <= len(proof.reference) <= 256):
            raise BoundaryDenied('SIGNUP_CHALLENGE_REJECTED')
        try: issued = utc(proof.issued_at)
        except (ValueError, TypeError, AttributeError): raise BoundaryDenied('SIGNUP_CHALLENGE_REJECTED') from None
        if not now - timedelta(seconds=p.max_age_seconds) <= issued <= now:
            raise BoundaryDenied('SIGNUP_CHALLENGE_EXPIRED')
        hashed = lambda value: hmac.new(p.hash_key, value.encode(), hashlib.sha256).hexdigest()
        network = hashed('peer:' + peer)
        # Replay identity survives rotation of the private network-hash key.
        challenge = hashlib.sha256(('challenge:' + proof.hostname + ':' + proof.reference).encode()).hexdigest()
        row = control(db, 'signup')  # one lock for network/challenge/identity admission
        key = uuid5(NAMESPACE_URL, 'credx:signup-proof:' + challenge)
        if db.scalar(select(OutboxMessage.id).where(OutboxMessage.id == key)) is not None:
            raise BoundaryDenied('SIGNUP_CHALLENGE_REPLAY')
        events = row.payload.get('perimeter_events', [])
        if type(events) is not list or len(events) > 128: raise BoundaryDenied('SIGNUP_PERIMETER_LEDGER_INVALID')
        retained = []
        for event in events:
            try: at = utc(datetime.fromisoformat(event['at'])); identity = event['network']
            except (KeyError, TypeError, ValueError): raise BoundaryDenied('SIGNUP_PERIMETER_LEDGER_INVALID') from None
            if at > now: raise BoundaryDenied('SIGNUP_CLOCK_ROLLBACK')
            if type(identity) is not str or len(identity) != 64: raise BoundaryDenied('SIGNUP_PERIMETER_LEDGER_INVALID')
            if at > now - timedelta(hours=1): retained.append(event)
        if len(retained) >= 128 or sum(e['network'] == network for e in retained) >= p.per_network_hour:
            raise BoundaryDenied('SIGNUP_NETWORK_QUOTA_EXHAUSTED')
        # Existing identity/global quota is independent of module/AI budgets.
        identity = admit(db, email, now=now, limits=limits)
        row.payload = {**row.payload, 'perimeter_events': retained + [{'network': network, 'at': now.isoformat()}]}
        db.add(OutboxMessage(id=key, topic=TOPIC, payload={'policy': p.reference,
            'consumed_at': now.isoformat(), 'identity': identity}))
        db.flush()
        return identity  # no commit: rollback of account creation restores admission
