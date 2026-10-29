"""Exact-venue broker quote reads for display sizing, with no price fallbacks."""
import math
import re
from datetime import datetime, timezone


def validate_instruments(instruments):
    if not 1 <= len(instruments) <= 500 or any(not isinstance(key, str) or not re.fullmatch(r"(?:NSE|BSE):[A-Z0-9&_.-]{1,64}", key) for key in instruments):
        raise ValueError("Choose 1 to 500 exact NSE/BSE instruments")
    return sorted(set(instruments))


async def read_display_quotes(service, token, instruments):
    # One broker read for the entire bounded batch. No per-row request fanout.
    raw = await service.get_quotes(token, instruments)
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
    return {"quotes": quotes, "missing": missing}
