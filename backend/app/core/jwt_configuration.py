"""Dependency-free JWT configuration validation for startup and deploy preflight."""

import os
import re
import sys


def validate_jwt_secret_key(value: str | None) -> None:
    """Reject missing, malformed, and repeated keys without exposing their values."""
    # Require an unambiguous representation of a full 256-bit HS256 key.
    # Format checks cannot prove entropy: the operator must generate random bytes.
    if value is None or re.fullmatch(r"[0-9a-fA-F]{64}", value) is None:
        raise ValueError(
            "JWT_SECRET_KEY must be 32 random bytes encoded as 64 hexadecimal characters"
        )
    decoded = bytes.fromhex(value)
    if any(decoded == decoded[:size] * (32 // size) for size in (1, 2, 4, 8, 16)):
        raise ValueError("JWT_SECRET_KEY must not use a repeated placeholder pattern")


if __name__ == "__main__":
    try:
        validate_jwt_secret_key(os.environ.get("JWT_SECRET_KEY"))
    except ValueError as error:
        # Do not render a traceback, raw environment, fingerprint, or input value.
        print(str(error), file=sys.stderr)
        sys.exit(1)
    print("JWT configuration valid")
