"""Validate the runtime JWT signing key without loading application dependencies."""

import os
import re
import sys


def signing_key(supplied: list[str]) -> str:
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
    return supplied[0]


if __name__ == "__main__":
    environment = {name.lower(): value for name, value in os.environ.items()}
    supplied = [environment[name] for name in ("jwt_signing_key", "jwt_secret", "secret_key")
                if name in environment]
    try:
        signing_key(supplied)
    except ValueError as error:
        sys.exit(str(error))
