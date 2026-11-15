"""Owner admission primitive for the separate UAT entrypoint.

This module does not verify signatures or mount production routes. The caller
must supply claims from its authoritative Google verifier, never request JSON.
No production configuration, account resolver, or session helper is imported.
"""
from dataclasses import dataclass
from collections.abc import Mapping


OWNER_EMAIL = "tarun.singh6893@gmail.com"


class AdmissionDenied(ValueError):
    """Safe error containing no claim, credential, or account details."""


@dataclass(frozen=True)
class OwnerPolicy:
    environment: str
    allowed_email: str
    google_audience: str

    def __post_init__(self):
        if (self.environment != "uat" or self.allowed_email != OWNER_EMAIL
                or not isinstance(self.google_audience, str)
                or not self.google_audience.endswith(".apps.googleusercontent.com")
                or self.google_audience != self.google_audience.strip()):
            raise AdmissionDenied("Invalid UAT admission configuration")

    def admit_verified_claims(self, claims: Mapping) -> str:
        """Additional policy AFTER signature, expiration and nonce verification."""
        if not isinstance(claims, Mapping):
            raise AdmissionDenied("UAT identity denied")
        email = claims.get("email")
        if (claims.get("iss") not in ("accounts.google.com", "https://accounts.google.com")
                or claims.get("aud") != self.google_audience
                or claims.get("email_verified") is not True
                or not isinstance(claims.get("sub"), str) or not claims["sub"].strip()
                or not isinstance(email, str)
                or email.strip().lower() != self.allowed_email):
            raise AdmissionDenied("UAT identity denied")
        # Deliberately no Gmail dot/plus alias normalization.
        return self.allowed_email

    async def resolve_verified_owner(self, claims, resolve):
        """Reject non-owner before invoking a profile-creating resolver."""
        email = self.admit_verified_claims(claims)
        user = await resolve(email)
        self.require_active_owner(user.email, user.is_active)
        return user

    def require_active_owner(self, email, active):
        if (active is not True or not isinstance(email, str)
                or email.strip().lower() != self.allowed_email):
            raise AdmissionDenied("UAT identity denied")

