import os
import time
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from jose import JWTError, jwt
from passlib.hash import argon2
from app.core.config import settings
from app.core.uat2 import uat2_mode, require_uat2_owner

# Password hashing
pwd_context = argon2.using(
    memory_cost=65536,  # 64MB (OWASP recommends 19MB+)[citation:7]
    time_cost=3,        # 3 iterations
    parallelism=4       # 4 parallel lanes
)

# JWT settings
SECRET_KEY = "your-secret-key-change-in-production"  # Local dev/test fixture only; public use is refused
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 7


def signing_key():
    if not uat2_mode():
        value = os.getenv("JWT_SIGNING_KEY", "")
        if len(value) >= 32 and value != SECRET_KEY:
            return value
        if settings.environment.lower() in {'development','test'}:
            return SECRET_KEY
        raise RuntimeError("Public service requires an independent signing key")
    value = os.getenv("UAT2_JWT_SIGNING_KEY", "")
    if len(value) < 32 or value == SECRET_KEY:
        raise RuntimeError("Independent UAT2 signing key is required")
    return value


def token_claims(payload):
    if uat2_mode():
        require_uat2_owner(payload.get("email"))
        payload.update(iss="https://uat2.cred-x.in", aud="credx-uat2")
    else:
        payload.update(iss="https://cred-x.in", aud="credx-api")
    return payload


class PasswordUtils:
    """Password hashing utilities."""
    
    @staticmethod
    def hash_password(password: str) -> str:
        """Hash password using bcrypt."""
        return pwd_context.hash(password)
    
    @staticmethod
    def verify_password(plain_password: str, hashed_password: str) -> bool:
        """Verify password against hash."""
        return pwd_context.verify(plain_password, hashed_password)


class TokenData:
    """Token payload data."""
    
    def __init__(
        self,
        sub: int,  # user_id
        email: str,
        role: str,
        exp: datetime | None = None,
        iat: datetime | None = None
    ):
        self.sub = sub
        self.email = email
        self.role = role
        self.exp = exp or datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        self.iat = iat or datetime.utcnow()
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JWT encoding."""
        return {
            "sub": str(self.sub),
            "email": self.email,
            "role": self.role,
            "exp": self.exp,
            "iat": self.iat
        }


class JWTUtils:
    """JWT token utilities."""
    
    @staticmethod
    def create_access_token(
        user_id: int,
        email: str,
        role: str,
        expires_delta: Optional[timedelta] = None,
        *, auth_time: float | None = None
    ) -> str:
        """
        Create JWT access token.
        
        Args:
            user_id: User ID
            email: User email
            role: User role
            expires_delta: Optional custom expiration time
        
        Returns:
            Encoded JWT token
        """
        if expires_delta:
            expire = datetime.utcnow() + expires_delta
        else:
            expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        
        token_data = {
            "sub": str(user_id),
            "type": "access",
            "email": email,
            "role": role,
            "exp": expire,
            "iat": datetime.utcnow(),
            "auth_time": time.time() if auth_time is None else auth_time
        }
        
        encoded_jwt = jwt.encode(token_claims(token_data), signing_key(), algorithm=ALGORITHM)
        return encoded_jwt
    
    @staticmethod
    def create_refresh_token(user_id: int, email: str, *, auth_time: float | None = None) -> str:
        """
        Create JWT refresh token.
        
        Args:
            user_id: User ID
            email: User email
        
        Returns:
            Encoded JWT refresh token
        """
        expire = datetime.utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
        
        token_data = {
            "sub": str(user_id),
            "email": email,
            "type": "refresh",
            "exp": expire,
            "iat": datetime.utcnow(),
            "auth_time": time.time() if auth_time is None else auth_time
        }
        
        encoded_jwt = jwt.encode(token_claims(token_data), signing_key(), algorithm=ALGORITHM)
        return encoded_jwt
    
    @staticmethod
    def verify_token(token: str) -> Optional[Dict[str, Any]]:
        """
        Verify and decode JWT token.
        
        Args:
            token: JWT token to verify
        
        Returns:
            Token payload if valid, None otherwise
        """
        try:
            if uat2_mode():
                payload = jwt.decode(token, signing_key(), algorithms=[ALGORITHM],
                                     issuer="https://uat2.cred-x.in", audience="credx-uat2")
                require_uat2_owner(payload.get("email"))
            else:
                payload = jwt.decode(token, signing_key(), algorithms=[ALGORITHM],
                                     issuer="https://cred-x.in", audience="credx-api")
            import math
            if payload.get('type') not in {'access','refresh'} or not str(payload.get('sub','')).isdigit():
                return None
            if int(payload['sub']) < 1:
                return None
            for claim in ('exp','iat','auth_time'):
                value=payload.get(claim)
                if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
                    return None
            if payload['iat'] > time.time()+1 or payload['auth_time'] > time.time()+1 or payload['exp'] <= time.time():
                return None
            return payload
        except (JWTError, TypeError, ValueError, OverflowError):
            return None
    
    @staticmethod
    def decode_token(token: str) -> Optional[Dict[str, Any]]:
        """
        Decode JWT token without verification (for debugging).
        
        Args:
            token: JWT token to decode
        
        Returns:
            Token payload if valid, None otherwise
        """
        try:
            payload = jwt.decode(
                token,
                key=signing_key(),
                options={"verify_signature": False}
            )
            return payload
        except (JWTError, TypeError, ValueError, OverflowError):
            return None


class AuthUtils:
    """Combined authentication utilities."""
    
    @staticmethod
    def create_tokens(user_id: int, email: str, role: str, *, auth_time: float | None = None) -> Dict[str, str]:
        """
        Create both access and refresh tokens.
        
        Args:
            user_id: User ID
            email: User email
            role: User role
        
        Returns:
            Dictionary with access_token and refresh_token
        """
        authenticated = time.time() if auth_time is None else auth_time
        return {
            "access_token": JWTUtils.create_access_token(user_id, email, role, auth_time=authenticated),
            "refresh_token": JWTUtils.create_refresh_token(user_id, email, auth_time=authenticated),
            "token_type": "bearer"
        }
