from pydantic import BaseModel, EmailStr, Field
from typing import Optional
from datetime import datetime
from enum import Enum


class UserRole(str, Enum):
    """User role enumeration."""
    ADMIN = "admin"
    USER = "user"
    VIEWER = "viewer"


# Request schemas
class UserRegisterRequest(BaseModel):
    """User registration request."""
    email: EmailStr
    username: str = Field(..., min_length=3, max_length=100)
    password: str = Field(..., min_length=8, max_length=72)
    full_name: Optional[str] = Field(None, max_length=255)
    
    class Config:
        json_schema_extra = {
            "example": {
                "email": "user@example.com",
                "username": "john_doe",
                "password": "SecurePass123!",
                "full_name": "John Doe"
            }
        }


class UserLoginRequest(BaseModel):
    """User login request."""
    email: Optional[EmailStr] = None
    username: Optional[str] = None
    password: str
    
    class Config:
        json_schema_extra = {
            "example": {
                "email": "user@example.com",
                "password": "SecurePass123!"
            }
        }


class RefreshTokenRequest(BaseModel):
    """Refresh token request."""
    refresh_token: str


class UpdatePasswordRequest(BaseModel):
    """Update password request."""
    current_password: str
    new_password: str = Field(..., min_length=8, max_length=255)
    confirm_password: str


class UpdateProfileRequest(BaseModel):
    """Update user profile request."""
    full_name: Optional[str] = Field(None, max_length=255)
    avatar_url: Optional[str] = None
    bio: Optional[str] = None
    timezone: Optional[str] = None
    notification_preferences: Optional[str] = None  # all, important, none
    theme_preference: Optional[str] = None  # light, dark


class ForgotPasswordRequest(BaseModel):
    """Forgot password request."""
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    """Reset password request."""
    token: str
    new_password: str = Field(..., min_length=8, max_length=255)
    confirm_password: str


# Response schemas
class TokenResponse(BaseModel):
    """Token response."""
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int = 900  # 15 minutes in seconds


class WebSocketTicketResponse(BaseModel):
    """One-time credential for a single WebSocket connection."""
    ticket: str
    expires_in: int


class UserProfileResponse(BaseModel):
    """User profile response."""
    user_id: int
    avatar_url: Optional[str]
    bio: Optional[str]
    timezone: str
    notification_preferences: str
    theme_preference: str
    created_at: datetime
    updated_at: datetime
    
    class Config:
        from_attributes = True


class UserResponse(BaseModel):
    """User response (non-sensitive)."""
    id: int
    email: str
    username: str
    full_name: Optional[str]
    role: str
    is_active: bool
    is_verified: bool
    created_at: datetime
    updated_at: datetime
    last_login: Optional[datetime]
    profile: Optional[UserProfileResponse]
    
    class Config:
        from_attributes = True


class UserDetailResponse(BaseModel):
    """Detailed user response."""
    id: int
    email: str
    username: str
    full_name: Optional[str]
    role: str
    is_active: bool
    is_verified: bool
    created_at: datetime
    updated_at: datetime
    last_login: Optional[datetime]
    profile: Optional[UserProfileResponse]
    
    class Config:
        from_attributes = True


class AuthResponse(BaseModel):
    """Authentication response."""
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserResponse
    expires_in: int = 900


class LoginResponse(BaseModel):
    """Login response."""
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserResponse
    expires_in: int = 900


class RegisterResponse(BaseModel):
    """Registration response."""
    id: int
    email: str
    username: str
    message: str = "User registered successfully. Please verify your email."
    
    class Config:
        from_attributes = True


class APIKeyCreateRequest(BaseModel):
    """Create API key request."""
    name: str = Field(..., max_length=255)
    expires_in_days: Optional[int] = None  # None = no expiry


class APIKeyResponse(BaseModel):
    """API key response."""
    id: int
    key: str
    name: str
    is_active: bool
    created_at: datetime
    last_used_at: Optional[datetime]
    expires_at: Optional[datetime]
    
    class Config:
        from_attributes = True


class ActivityLogResponse(BaseModel):
    """Activity log response."""
    id: int
    action: str
    resource_type: Optional[str]
    resource_id: Optional[int]
    details: Optional[str]
    ip_address: Optional[str]
    created_at: datetime
    
    class Config:
        from_attributes = True
