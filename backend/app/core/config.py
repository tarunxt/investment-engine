import os
import re
from datetime import datetime, timezone
from typing import Optional

from pydantic import AliasChoices, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_TRUE_ENV_VALUES = {"1", "true", "t", "yes", "y", "on", "debug", "development", "dev"}
_FALSE_ENV_VALUES = {"0", "false", "f", "no", "n", "off", "release", "prod", "production"}


class Settings(BaseSettings):
    """Application configuration from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env", case_sensitive=False, extra="ignore", hide_input_in_errors=True,
    )

    # Keep aliases as separate fields so conflicting/blank legacy values cannot
    # be silently hidden by AliasChoices. Never expose these in repr or dumps.
    jwt_signing_key: Optional[SecretStr] = Field(default=None, repr=False, exclude=True)
    jwt_secret: Optional[SecretStr] = Field(default=None, repr=False, exclude=True)
    secret_key: Optional[SecretStr] = Field(default=None, repr=False, exclude=True)

    @model_validator(mode="after")
    def _require_private_jwt_signing_key(self) -> "Settings":
        supplied = [
            value.get_secret_value()
            for value in (self.jwt_signing_key, self.jwt_secret, self.secret_key)
            if value is not None
        ]
        if not supplied:
            raise ValueError("JWT_SIGNING_KEY is required (private server-generated key)")
        # A single explicit format avoids whitespace/encoding ambiguity. Format
        # checks cannot establish randomness: generate 32 bytes with a CSPRNG.
        if any(re.fullmatch(r"[0-9a-f]{64}", value) is None for value in supplied):
            raise ValueError("JWT signing keys must encode 32 random bytes as 64 lowercase hex characters")
        if any(
            value == value[:size] * (64 // size)
            for value in supplied for size in (1, 2, 4, 8, 16, 32)
        ):
            raise ValueError("JWT signing keys must not be repeated/default patterns")
        if any(value != supplied[0] for value in supplied[1:]):
            raise ValueError("Conflicting JWT_SIGNING_KEY, JWT_SECRET or SECRET_KEY configuration")
        # Canonical > JWT_SECRET > SECRET_KEY, with all supplied names required
        # to agree. No default or previous-key verification path is supported.
        self.jwt_signing_key = SecretStr(supplied[0])
        return self

    # Database
    database_url: str
    
    # Redis
    redis_url: str
    
    # Disabled by default; local review must opt in after schema checks.
    recommendation_audit_enabled: bool = False
    recommendation_audit_recovery_stored_only_enabled: bool = False
    recommendation_audit_external_enabled: bool = False
    recommendation_audit_fundamentals_enabled: bool = False
    recommendation_audit_daily_cap_usd: float = Field(default=0, ge=0, le=100)
    recommendation_audit_kite_incremental_cost_usd: float | None = Field(default=None, ge=0, le=100)

    # API Keys
    openai_api_key: Optional[str] = None
    gemini_api_key: Optional[str] = None
    gemini_api_key_fallback: Optional[str] = None
    gemini_api_key_fallback_2: Optional[str] = None
    gemini_api_key_fallback_3: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    deepseek_api_key: Optional[str] = None
    deepseek_api_base: Optional[str] = None  # e.g., "https://api.deepseek.com/v1"

    # Zerodha Kite Connect
    zerodha_api_key: Optional[str] = None
    zerodha_api_secret: Optional[str] = None
    zerodha_token_encryption_key: Optional[str] = None  # Fernet key for access_token at-rest encryption
    zerodha_enable_direct_market_orders: bool = False  # Enable only when the server egress IP is Kite-whitelisted

    # Operator-approved manual protected-order exception; automated writes stay blocked.
    zerodha_recovery_manual_orders_enabled: bool = True

    # Google Sheets OAuth
    google_client_id: Optional[str] = None
    google_client_secret: Optional[str] = None
    google_redirect_uri: str = "http://localhost:3000/console/google-sheets/callback"
    google_sheets_encryption_key: Optional[str] = None  # Fernet key for token encryption

    # Third-party services
    tavily_api_key: str = ""

    # Celery
    celery_broker_url: Optional[str] = None
    celery_result_backend: Optional[str] = None
    
    # Application
    debug: bool = False
    environment: str = "production"
    auth_disabled: bool = False
    app_name: str = "AI Investment Platform"
    version: str = "0.1.0"
    frontend_url: str = "http://localhost:3000"
    
    # Email
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = 587
    smtp_user: Optional[str] = None
    smtp_password: Optional[str] = None
    # Accept both documented SMTP_* names and the legacy EMAILS_* names already
    # present on older production hosts. Keep the SMTP_* fields canonical in code.
    smtp_from_email: str = Field(
        default="noreply@example.com",
        validation_alias=AliasChoices("SMTP_FROM_EMAIL", "EMAILS_FROM_EMAIL"),
    )
    smtp_from_name: str = Field(
        default="AI Investment Platform",
        validation_alias=AliasChoices("SMTP_FROM_NAME", "EMAILS_FROM_NAME"),
    )
    # Dedicated cross-account inbox monitored by the Stage 1 clustering webhook.
    bullpen_stage1_completion_recipient: str = "tarunindian007@gmail.com"
    
    # Logging
    log_level: str = "INFO"
    
    @field_validator("debug", mode="before")
    @classmethod
    def _coerce_debug_flag(cls, value: object) -> object:
        if not isinstance(value, str):
            return value

        normalized = value.strip().lower()
        if normalized in _TRUE_ENV_VALUES:
            return True
        if normalized in _FALSE_ENV_VALUES:
            return False
        return value


DATABASE_URL = os.getenv("DATABASE_URL", "")
REDIS_URL = os.getenv("REDIS_URL", "")

if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")

if not REDIS_URL:
    raise ValueError("REDIS_URL environment variable is required")

# Global settings instance
settings = Settings(database_url=os.getenv("DATABASE_URL", ""), redis_url=os.getenv("REDIS_URL", ""))
settings_loaded_at_utc = datetime.now(timezone.utc).isoformat()


def _clean_env_value(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def get_gemini_api_keys() -> list[str]:
    """Resolve Gemini API keys with stable slot order and env alias support."""
    slot_1 = _clean_env_value(os.getenv("GEMINI_API_KEY")) or _clean_env_value(os.getenv("GEMINI_API_KEY_1")) or _clean_env_value(getattr(settings, "gemini_api_key", None))
    slot_2 = _clean_env_value(os.getenv("GEMINI_API_KEY_FALLBACK")) or _clean_env_value(os.getenv("GEMINI_API_KEY_2")) or _clean_env_value(getattr(settings, "gemini_api_key_fallback", None))
    slot_3 = _clean_env_value(os.getenv("GEMINI_API_KEY_FALLBACK_2")) or _clean_env_value(os.getenv("GEMINI_API_KEY_3")) or _clean_env_value(getattr(settings, "gemini_api_key_fallback_2", None))
    slot_4 = _clean_env_value(os.getenv("GEMINI_API_KEY_FALLBACK_3")) or _clean_env_value(os.getenv("GEMINI_API_KEY_4")) or _clean_env_value(getattr(settings, "gemini_api_key_fallback_3", None))

    resolved: list[str] = []
    for key in (slot_1, slot_2, slot_3, slot_4):
        if key and key not in resolved:
            resolved.append(key)

    # Optional list-style key input for docker/env convenience.
    extra_keys_raw = _clean_env_value(os.getenv("GEMINI_API_KEYS"))
    if extra_keys_raw:
        for key in [part.strip() for part in extra_keys_raw.split(",")]:
            if key and key not in resolved:
                resolved.append(key)

    return resolved
