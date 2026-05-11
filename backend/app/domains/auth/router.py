import secrets
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.logging import get_logger
from app.core.security import AuthUtils, JWTUtils, PasswordUtils
from app.domains.auth.dependencies import get_current_user, require_admin
from app.domains.auth.models import ActivityLog, User, UserProfile, UserRole
from app.domains.auth.schemas import (
    ForgotPasswordRequest,
    LoginResponse,
    RefreshTokenRequest,
    RegisterResponse,
    ResetPasswordRequest,
    UpdatePasswordRequest,
    UpdateProfileRequest,
    UserLoginRequest,
    UserRegisterRequest,
    UserResponse,
)
from app.domains.auth.tasks import send_reset_password_email_task
from app.infrastructure.database.session import get_async_db
from app.shared.exceptions import NotFoundException, ValidationException

router = APIRouter(prefix="/auth", tags=["auth"])
logger = get_logger(__name__)


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(request: UserRegisterRequest, db: AsyncSession = Depends(get_async_db)):
    result = await db.execute(
        select(User).where((User.email == request.email) | (User.username == request.username))
    )
    existing = result.scalar_one_or_none()
    if existing:
        field = "email" if str(existing.email) == request.email else "username"
        raise ValidationException("Email or username already registered", {"field": field})

    if len(request.password) < 8:
        raise ValidationException("Password must be at least 8 characters")
    if not any(c.isupper() for c in request.password):
        raise ValidationException("Password must contain uppercase letter")
    if not any(c.islower() for c in request.password):
        raise ValidationException("Password must contain lowercase letter")
    if not any(c.isdigit() for c in request.password):
        raise ValidationException("Password must contain digit")

    try:
        password_hash = PasswordUtils.hash_password(request.password)
    except ValueError as e:
        if "longer than 72 bytes" in str(e):
            raise HTTPException(400, detail="Password is too long (max 72 chars)")
        raise HTTPException(400, detail=f"Invalid password: {e}")

    user = User(
        email=request.email,
        username=request.username,
        password_hash=password_hash,
        full_name=request.full_name,
        role=UserRole.USER,
        is_active=True,
        is_verified=False,
    )
    db.add(user)
    await db.flush()
    db.add(UserProfile(user_id=user.id))
    db.add(ActivityLog(user_id=user.id, action="register", details="User registered"))
    await db.commit()

    logger.info("New user registered: %s", user.email)
    return RegisterResponse(id=user.id, email=user.email, username=user.username)


@router.post("/login", response_model=LoginResponse)
async def login(request: UserLoginRequest, db: AsyncSession = Depends(get_async_db)):
    if request.email:
        result = await db.execute(
            select(User).where(User.email == request.email).options(selectinload(User.profile))
        )
    elif request.username:
        result = await db.execute(
            select(User).where(User.username == request.username).options(selectinload(User.profile))
        )
    else:
        raise ValidationException("Either email or username is required")

    user = result.scalar_one_or_none()
    if not user or not PasswordUtils.verify_password(request.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="User account is inactive")

    user.last_login = datetime.utcnow()
    db.add(ActivityLog(user_id=user.id, action="login", details="User logged in"))
    await db.commit()

    tokens = AuthUtils.create_tokens(user.id, user.email, user.role.value)
    return LoginResponse(
        access_token=tokens["access_token"],
        refresh_token=tokens["refresh_token"],
        token_type="bearer",
        user=UserResponse.model_validate(user),
        expires_in=900,
    )


@router.post("/refresh", response_model=LoginResponse)
async def refresh_token(request: RefreshTokenRequest, db: AsyncSession = Depends(get_async_db)):
    payload = JWTUtils.verify_token(request.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")

    result = await db.execute(
        select(User).where(User.id == int(sub)).options(selectinload(User.profile))
    )
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    tokens = AuthUtils.create_tokens(user.id, user.email, user.role.value)
    return LoginResponse(
        access_token=tokens["access_token"],
        refresh_token=tokens["refresh_token"],
        token_type="bearer",
        user=UserResponse.model_validate(user),
        expires_in=900,
    )


@router.post("/logout")
async def logout(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    db.add(ActivityLog(user_id=current_user.id, action="logout", details="User logged out"))
    await db.commit()
    return {"message": "Logged out successfully"}


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    current_user: User = Depends(get_current_user),
):
    return UserResponse.model_validate(current_user)


@router.post("/forgot-password")
async def forgot_password(
    request: ForgotPasswordRequest, db: AsyncSession = Depends(get_async_db)
):
    result = await db.execute(select(User).where(User.email == request.email))
    user = result.scalar_one_or_none()
    if user:
        token = secrets.token_urlsafe(32)
        user.reset_password_token = token
        user.reset_password_expires = datetime.utcnow() + timedelta(hours=1)
        await db.commit()
        send_reset_password_email_task.delay(user.email, token)
    # Always return success to prevent user enumeration
    return {"message": "If an account with that email exists, a password reset link has been sent."}


@router.post("/reset-password")
async def reset_password(
    request: ResetPasswordRequest, db: AsyncSession = Depends(get_async_db)
):
    if request.new_password != request.confirm_password:
        raise ValidationException("Passwords do not match")

    result = await db.execute(
        select(User).where(
            User.reset_password_token == request.token,
            User.reset_password_expires > datetime.utcnow(),
        )
    )
    user = result.scalar_one_or_none()
    if not user:
        raise ValidationException("Invalid or expired reset token")

    user.password_hash = PasswordUtils.hash_password(request.new_password)
    user.reset_password_token = None
    user.reset_password_expires = None
    db.add(ActivityLog(user_id=user.id, action="reset_password", details="Password reset via token"))
    await db.commit()

    return {"message": "Password reset successful"}


@router.put("/password")
async def update_password(
    request: UpdatePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    if not PasswordUtils.verify_password(request.current_password, current_user.password_hash):
        raise ValidationException("Current password is incorrect")
    if request.new_password != request.confirm_password:
        raise ValidationException("Passwords do not match")
    if request.new_password == request.current_password:
        raise ValidationException("New password must be different from current password")

    current_user.password_hash = PasswordUtils.hash_password(request.new_password)
    db.add(ActivityLog(user_id=current_user.id, action="change_password", details="Password changed"))
    await db.commit()

    return {"message": "Password updated successfully"}


@router.get("/profile", response_model=UpdateProfileRequest)
async def get_profile(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    result = await db.execute(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise NotFoundException("User profile not found")
    return UpdateProfileRequest(
        full_name=current_user.full_name,
        avatar_url=profile.avatar_url,
        bio=profile.bio,
        timezone=profile.timezone,
        notification_preferences=profile.notification_preferences,
        theme_preference=profile.theme_preference,
    )


@router.put("/profile")
async def update_profile(
    request: UpdateProfileRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    if request.full_name is not None:
        current_user.full_name = request.full_name

    result = await db.execute(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    )
    profile = result.scalar_one_or_none()
    if not profile:
        profile = UserProfile(user_id=current_user.id)
        db.add(profile)

    for field in ("avatar_url", "bio", "timezone", "notification_preferences", "theme_preference"):
        val = getattr(request, field)
        if val is not None:
            setattr(profile, field, val)

    db.add(ActivityLog(user_id=current_user.id, action="update_profile", details="Profile updated"))
    await db.commit()

    return {"message": "Profile updated successfully"}
