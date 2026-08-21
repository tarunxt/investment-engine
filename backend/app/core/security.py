from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from jose import JWTError, jwt
from passlib.hash import argon2
from app.core.config import settings

# Password hashing
pwd_context = argon2.using(
    memory_cost=65536,  # 64MB (OWASP recommends 19MB+)[citation:7]
    time_cost=3,        # 3 iterations
    parallelism=4       # 4 parallel lanes
)

# JWT settings
SECRET_KEY = "your-secret-key-change-in-production"  # TODO: Will read from env 
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 7


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
        expires_delta: Optional[timedelta] = None
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
            "email": email,
            "role": role,
            "exp": expire,
            "iat": datetime.utcnow()
        }
        
        encoded_jwt = jwt.encode(token_data, SECRET_KEY, algorithm=ALGORITHM)
        return encoded_jwt
    
    @staticmethod
    def create_refresh_token(user_id: int, email: str) -> str:
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
            "iat": datetime.utcnow()
        }
        
        encoded_jwt = jwt.encode(token_data, SECRET_KEY, algorithm=ALGORITHM)
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
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            return payload
        except JWTError:
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
                key=SECRET_KEY,
                options={"verify_signature": False}
            )
            return payload
        except JWTError:
            return None


class AuthUtils:
    """Combined authentication utilities."""
    
    @staticmethod
    def create_tokens(user_id: int, email: str, role: str) -> Dict[str, str]:
        """
        Create both access and refresh tokens.
        
        Args:
            user_id: User ID
            email: User email
            role: User role
        
        Returns:
            Dictionary with access_token and refresh_token
        """
        return {
            "access_token": JWTUtils.create_access_token(user_id, email, role),
            "refresh_token": JWTUtils.create_refresh_token(user_id, email),
            "token_type": "bearer"
        }
