from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import Optional
from datetime import datetime
from app.core.logging import get_logger
from app.db.dependencies import get_db
from app.db.auth_dependencies import get_current_user, require_admin
from app.models.user import User, UserRole, UserProfile, ActivityLog
from app.schemas.user import (
    UserRegisterRequest, UserLoginRequest, RefreshTokenRequest,
    LoginResponse, RegisterResponse, UserResponse,
    UpdatePasswordRequest, UpdateProfileRequest,
    ForgotPasswordRequest, ResetPasswordRequest
)
from app.core.security import PasswordUtils, JWTUtils, AuthUtils
from app.core.exceptions import ValidationException, NotFoundException
import secrets
from datetime import timedelta
from app.workers.tasks import send_reset_password_email_task

router = APIRouter(prefix="/auth", tags=["auth"])
logger = get_logger(__name__)


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(
    request: UserRegisterRequest,
    db: Session = Depends(get_db)
):
    """Register a new user."""
    
    # Check if user already exists
    existing_user: Optional[User] = db.query(User).filter(
        (User.email == request.email) |
        (User.username == request.username)
    ).first()
    
    if existing_user:
        field = (
            "email"
            if str(existing_user.email) == request.email
            else "username"
        )

        raise ValidationException(
            "Email or username already registered",
            {"field": field}
        )
    
    # Validate password requirements
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
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Password is too long. Maximum password length is 72 characters."
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid password: {str(e)}"
        )
    except Exception as e:
        logger.error(f"Error hashing password: {str(e)}", exc_info=e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An error occurred while processing the password"
        )

    # Create user
    user = User(
        email=request.email,
        username=request.username,
        password_hash=password_hash,
        full_name=request.full_name,
        role=UserRole.USER,
        is_active=True,
        is_verified=False  # Email verification required
    )
    
    db.add(user)
    db.commit()
    db.refresh(user)
    
    # Create user profile
    profile = UserProfile(user_id=user.id)
    db.add(profile)
    db.commit()
    
    # Log activity
    activity = ActivityLog(
        user_id=user.id,
        action="register",
        details="User registered"
    )
    db.add(activity)
    db.commit()
    
    logger.info(f"New user registered: {user.email}")
    
    return RegisterResponse(
        id=user.id,
        email=user.email,
        username=user.username,
        message="User registered successfully. Please verify your email."
    )


@router.post("/login", response_model=LoginResponse)
async def login(
    request: UserLoginRequest,
    db: Session = Depends(get_db)
):
    """Login with email or username and password."""
    
    # Find user by email or username
    user = None
    if request.email:
        user = db.query(User).filter(User.email == request.email).first()
    elif request.username:
        user = db.query(User).filter(User.username == request.username).first()
    else:
        raise ValidationException("Either email or username is required")
    
    if not user:
        logger.warning(f"Login attempt for non-existent user: {request.email or request.username}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email/username or password"
        )
    
    # Verify password
    if not PasswordUtils.verify_password(request.password, user.password_hash):
        logger.warning(f"Failed login attempt for user: {user.email}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email/username or password"
        )
    
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is inactive"
        )
    
    # Update last login
    user.last_login = datetime.utcnow()
    db.commit()
    
    # Create tokens
    tokens = AuthUtils.create_tokens(user.id, user.email, user.role.value)
    
    # Log activity
    activity = ActivityLog(
        user_id=user.id,
        action="login",
        details="User logged in"
    )
    db.add(activity)
    db.commit()
    
    logger.info(f"User logged in: {user.email}")
    
    # Load profile for response
    db.refresh(user)
    
    return LoginResponse(
        access_token=tokens["access_token"],
        refresh_token=tokens["refresh_token"],
        token_type="bearer",
        user=UserResponse.model_validate(user),
        expires_in=900
    )


@router.post("/refresh", response_model=LoginResponse)
async def refresh_token(
    request: RefreshTokenRequest,
    db: Session = Depends(get_db)
):
    """Refresh access token using refresh token."""
    
    payload = JWTUtils.verify_token(request.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token"
        )
    
    sub = payload.get("sub")

    if sub is None:
        raise ValueError("Token missing 'sub'")

    user_id = int(sub)
    user = db.query(User).filter(User.id == user_id).first()
    
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive"
        )
    
    # Create new tokens
    tokens = AuthUtils.create_tokens(user.id, user.email, user.role.value)
    
    logger.info(f"Token refreshed for user: {user.email}")
    
    db.refresh(user)
    
    return LoginResponse(
        access_token=tokens["access_token"],
        refresh_token=tokens["refresh_token"],
        token_type="bearer",
        user=UserResponse.model_validate(user),
        expires_in=900
    )


@router.post("/logout")
async def logout(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Logout current user."""
    
    # Log activity
    activity = ActivityLog(
        user_id=current_user.id,
        action="logout",
        details="User logged out"
    )
    db.add(activity)
    db.commit()
    
    logger.info(f"User logged out: {current_user.email}")
    
    return {"message": "Logged out successfully"}


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get current user information."""
    
    db.refresh(current_user)
    return UserResponse.model_validate(current_user)

@router.post("/forgot-password")
async def forgot_password(
    request: ForgotPasswordRequest,
    db: Session = Depends(get_db)
):
    """Initiate forgot password process."""
    
    user = db.query(User).filter(User.email == request.email).first()
    if user:
        # Generate token
        token = secrets.token_urlsafe(32)
        user.reset_password_token = token
        user.reset_password_expires = datetime.utcnow() + timedelta(hours=1)
        db.commit()
        
        # Queue email task
        send_reset_password_email_task.delay(user.email, token)
        logger.info(f"Password reset initiated for: {user.email}")
    else:
        logger.warning(f"Forgot password attempt for non-existent email: {request.email}")

    # To prevent user enumeration, always return success
    return {"message": "If an account with that email exists, a password reset link has been sent."}


@router.post("/reset-password")
async def reset_password(
    request: ResetPasswordRequest,
    db: Session = Depends(get_db)
):
    """Reset password using token."""
    
    if request.new_password != request.confirm_password:
        raise ValidationException("Passwords do not match")
    
    user = db.query(User).filter(
        User.reset_password_token == request.token,
        User.reset_password_expires > datetime.utcnow()
    ).first()
    
    if not user:
        raise ValidationException("Invalid or expired reset token")
    
    # Update password
    user.password_hash = PasswordUtils.hash_password(request.new_password)
    user.reset_password_token = None
    user.reset_password_expires = None
    db.commit()
    
    # Log activity
    activity = ActivityLog(
        user_id=user.id,
        action="reset_password",
        details="User reset password using token"
    )
    db.add(activity)
    db.commit()
    
    logger.info(f"Password reset successful for: {user.email}")
    
    return {"message": "Password reset successful"}

@router.put("/password", status_code=status.HTTP_200_OK)
async def update_password(
    request: UpdatePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update user password."""
    
    # Verify current password
    if not PasswordUtils.verify_password(request.current_password, current_user.password_hash):
        raise ValidationException("Current password is incorrect")
    
    if request.new_password != request.confirm_password:
        raise ValidationException("Passwords do not match")
    
    if request.new_password == request.current_password:
        raise ValidationException("New password must be different from current password")
    
    # Validate password requirements
    if len(request.new_password) < 8:
        raise ValidationException("Password must be at least 8 characters")
    
    # Update password
    current_user.password_hash = PasswordUtils.hash_password(request.new_password)
    db.commit()
    
    # Log activity
    activity = ActivityLog(
        user_id=current_user.id,
        action="change_password",
        details="User changed password"
    )
    db.add(activity)
    db.commit()
    
    logger.info(f"Password updated for user: {current_user.email}")
    
    return {"message": "Password updated successfully"}


@router.get("/profile", response_model=UpdateProfileRequest)
async def get_profile(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get user profile."""
    
    profile = db.query(UserProfile).filter(UserProfile.user_id == current_user.id).first()
    if not profile:
        raise NotFoundException("User profile not found")
    
    return UpdateProfileRequest(
        full_name=current_user.full_name,
        avatar_url=profile.avatar_url,
        bio=profile.bio,
        timezone=profile.timezone,
        notification_preferences=profile.notification_preferences,
        theme_preference=profile.theme_preference
    )


@router.put("/profile", status_code=status.HTTP_200_OK)
async def update_profile(
    request: UpdateProfileRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update user profile."""
    
    # Update user info
    if request.full_name is not None:
        current_user.full_name = request.full_name
    
    db.commit()
    
    # Update profile
    profile = db.query(UserProfile).filter(UserProfile.user_id == current_user.id).first()
    if not profile:
        profile = UserProfile(user_id=current_user.id)
        db.add(profile)
    
    if request.avatar_url is not None:
        profile.avatar_url = request.avatar_url
    if request.bio is not None:
        profile.bio = request.bio
    if request.timezone is not None:
        profile.timezone = request.timezone
    if request.notification_preferences is not None:
        profile.notification_preferences = request.notification_preferences
    if request.theme_preference is not None:
        profile.theme_preference = request.theme_preference
    
    db.commit()
    
    # Log activity
    activity = ActivityLog(
        user_id=current_user.id,
        action="update_profile",
        details="User updated profile"
    )
    db.add(activity)
    db.commit()
    
    logger.info(f"Profile updated for user: {current_user.email}")
    
    return {"message": "Profile updated successfully"}
