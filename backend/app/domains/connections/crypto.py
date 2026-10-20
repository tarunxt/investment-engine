"""Version-selected Fernet envelopes with authenticated owner/binding claims.

The existing bare Zerodha token format remains in zerodha.crypto. No trial-key
fallback: retirement of old keys is an explicit operator action after rotation.
"""
import json
from dataclasses import dataclass,field
from typing import Mapping
from cryptography.fernet import Fernet,InvalidToken

class ConnectionFault(Exception):
    def __init__(self,code,status_code=409):
        self.code=code;self.status_code=status_code
        super().__init__(code)

@dataclass(frozen=True)
class ConnectionKeyring:
    keys:Mapping[int,str]=field(repr=False)
    active_version:int=1
    def __post_init__(self):
        try:
            if not self.keys or len(self.keys)>8 or self.active_version not in self.keys:raise ValueError()
            for version,key in self.keys.items():
                if not isinstance(version,int) or version<1:raise ValueError()
                Fernet(key.encode())
        except (ValueError,TypeError,AttributeError):raise ConnectionFault('ENCRYPTION_KEYRING_UNAVAILABLE',503) from None
    @classmethod
    def from_settings(cls):
        from app.core.config import settings
        try:
            encoded=settings.integration_encryption_keys
            if encoded:
                raw=encoded.get_secret_value() if hasattr(encoded,'get_secret_value') else encoded
                keys={int(k):v for k,v in json.loads(raw).items()}
            else:
                # Explicit version1 compatibility, never a fallback for v2+.
                keys={1:settings.zerodha_token_encryption_key} if settings.zerodha_token_encryption_key else {}
            return cls(keys,settings.integration_encryption_key_version)
        except ConnectionFault:raise
        except Exception:raise ConnectionFault('ENCRYPTION_KEYRING_UNAVAILABLE',503) from None
    def seal(self,payload:dict,version:int|None=None):
        version=self.active_version if version is None else version
        if version not in self.keys:raise ConnectionFault('ENCRYPTION_KEY_VERSION_UNAVAILABLE',503)
        return Fernet(self.keys[version].encode()).encrypt(json.dumps(payload,sort_keys=True).encode()).decode(),version
    def open(self,ciphertext:str,version:int):
        if version not in self.keys:raise ConnectionFault('ENCRYPTION_KEY_VERSION_UNAVAILABLE',503)
        try:
            value=json.loads(Fernet(self.keys[version].encode()).decrypt(ciphertext.encode()))
            if not isinstance(value,dict):raise ValueError()
            return value
        except (InvalidToken,ValueError,UnicodeError,TypeError,AttributeError):raise ConnectionFault('CONNECTION_CREDENTIAL_UNREADABLE') from None
