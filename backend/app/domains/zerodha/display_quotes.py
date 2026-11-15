"""Exact-venue quote reads for display sizing; estimates stay outside this API."""
import math
import re
from datetime import datetime, timezone


def validate_instruments(instruments):
    if not 1 <= len(instruments) <= 500 or any(not isinstance(key, str) or not re.fullmatch(r"(?:NSE|BSE):[A-Z0-9&_.-]{1,64}", key) for key in instruments):
        raise ValueError("Choose 1 to 500 exact NSE/BSE instruments")
    return sorted(set(instruments))


async def read_display_quotes(service, token, instruments, user_id=None):
    # One broker read for the entire bounded batch. No per-row request fanout.
    from .upstox_quotes import read_upstox_quotes
    broker_error = None
    try:
        raw = await service.get_quotes(token, instruments)
    except Exception as exc:
        broker_error = exc
        raw = {}
    received = datetime.now(timezone.utc).isoformat()
    quotes = []
    missing = []
    for instrument in instruments:
        row = raw.get(instrument) if isinstance(raw, dict) else None
        price = row.get("last_price") if isinstance(row, dict) else None
        if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 0:
            missing.append(instrument)
            continue
        quotes.append({"instrument": instrument, "price": price, "as_of": received, "source": "Zerodha broker /quote last_price · exact venue · server receipt time"})
    # Independently read the full batch for the provider comparison column.
    # Only absent Kite prices may use those values in the selected quote list.
    upstox = await read_upstox_quotes(user_id, instruments) if user_id is not None else []
    fallback = [row for row in upstox if row["instrument"] in missing]
    quotes.extend(fallback)
    filled = {row["instrument"] for row in fallback}
    missing = [key for key in missing if key not in filled]
    if broker_error is not None and not quotes:
        raise broker_error
    return {"quotes": quotes, "missing": missing, "upstox_quotes": upstox}


def quote_failure_detail(error):
    """Expose a safe broker category, never raw bodies, tokens or arbitrary text."""
    kind = getattr(error, 'error_type', None)
    message = str(getattr(error, 'message', '')).lower()
    if kind == 'PermissionException' or 'insufficient permission' in message:
        return 403, 'Zerodha denied market-data access (PermissionException). This connection cannot provide live quotes.'
    if kind == 'TokenException':
        return 409, 'Zerodha rejected the broker session (TokenException). Broker reconnection is required for quotes.'
    if kind == 'InputException':
        return 422, 'Zerodha rejected the quote instruments (InputException).'
    if kind == 'RateLimitException':
        return 429, 'Zerodha rate-limited quote reads (RateLimitException). Wait before retrying.'
    safe_kind = kind if kind in {'NetworkException', 'DataException', 'GeneralException'} else 'UnclassifiedBrokerError'
    return 502, f'Zerodha could not supply quotes ({safe_kind}).'
