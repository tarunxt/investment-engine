"""Manual, one-request diagnostic. Never run without separate live-call authorization.

Invoke with PYTHONPATH=backend python -m scripts.diagnose_upstox_quote
--instrument-key 'NSE_EQ|...' through the approved secret resolver. No token CLI
argument, credential printing, retries, alternate route or client identity override.
"""
import argparse
import asyncio
import json
import math
import os
import re

import httpx

from app.domains.zerodha.upstox_quotes import build_quote_request


def sanitized_result(status, headers, raw, credential, instrument_key):
    result = {'http_status': status, 'error_code': None, 'error_message': None, 'request_id': None, 'content_type': 'other', 'response_kind': None}
    mime = str(headers.get('content-type', '')).split(';', 1)[0].strip().lower()
    result['content_type'] = mime if mime in {'application/json','text/html','text/plain'} else 'missing' if not mime else 'other'
    def safe_text(value):
        if not isinstance(value, str):
            return None
        value = value.replace(credential, '[REDACTED]') if credential else value
        value = re.sub(r'(?i)bearer\s+\S+', 'Bearer [REDACTED]', value)
        value = re.sub(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[REDACTED]', value)
        value = re.sub(r'[A-Za-z0-9_+/=-]{40,}', '[REDACTED]', value)
        value = ''.join(char for char in value if char.isprintable())
        return value[:240]
    for key in ['x-request-id', 'x-correlation-id', 'request-id', 'x-amzn-requestid', 'cf-ray']:
        value = headers.get(key)
        if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9:._=;-]{1,160}', value) and (not credential or credential not in value):
            result['request_id'] = safe_text(value)
            break
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError, UnicodeDecodeError):
        result['response_kind'] = 'html' if raw.lstrip().lower().startswith((b'<!doctype html',b'<html')) else 'empty' if not raw else 'non_json'
        result['error_message'] = 'Non-JSON error response; body withheld' if status >= 400 else 'Non-JSON response; body withheld'
        return result
    result['response_kind'] = 'json_object' if isinstance(payload, dict) else 'json_array' if isinstance(payload,list) else 'json_scalar'
    if not isinstance(payload, dict):
        result['error_message'] = 'Unexpected JSON response shape; body withheld'
        return result
    candidates = [payload]
    for _ in range(3):
        for node in list(candidates):
            if not isinstance(node,dict): continue
            for key in ['errors','error','detail']:
                value = node.get(key)
                if isinstance(value,dict) and value not in candidates: candidates.append(value)
                if isinstance(value,list):
                    candidates.extend(item for item in value[:2] if isinstance(item,dict) and item not in candidates)
    for node in candidates:
        if result['error_code'] is None:
            code = node.get('errorCode',node.get('error_code',node.get('code')))
            if isinstance(code,str) and re.fullmatch(r'(?:UDAPI\d{1,12}|[A-Z][A-Z0-9_]{1,63})',code): result['error_code'] = code
        if result['error_message'] is None:
            for key in ['message','error_message','error_description','detail','reason','error','title']:
                if isinstance(node.get(key),str):
                    result['error_message'] = safe_text(node[key])
                    break
    if status == 200:
        rows = [row for row in payload.get('data', {}).values() if isinstance(row, dict) and row.get('instrument_token') == instrument_key] if isinstance(payload.get('data'), dict) else []
        price = rows[0].get('last_price') if len(rows) == 1 else None
        valid = isinstance(price, (int, float)) and not isinstance(price, bool) and math.isfinite(price) and price > 0
        result['error_message'] = 'Exact requested instrument returned a positive finite last_price' if valid else 'HTTP 200 without a valid exact-instrument quote'
    return result


async def diagnose(client, instrument_key, credential):
    """One send through the same request builder and httpx client as production."""
    try:
        request = build_quote_request(client, [instrument_key], credential)
        # Stream only a bounded error/quote body; never expose raw headers/body.
        response = await client.send(request, stream=True)
        try:
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk[:8192 - len(body)])
                if len(body) >= 8192:
                    break
            return sanitized_result(response.status_code, response.headers, bytes(body), credential, instrument_key)
        finally:
            await response.aclose()
    except (httpx.HTTPError, TimeoutError, ValueError, OSError) as error:
        return {"http_status": None, "error_code": type(error).__name__,
                "error_message": "Transport failed; exception details withheld", "request_id": None}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--instrument-key", required=True)
    args = parser.parse_args()
    credential = os.environ["UPSTOX_ANALYTICS_TOKEN"]
    async with asyncio.timeout(15):
        async with httpx.AsyncClient(timeout=6, follow_redirects=False) as client:
            result = await diagnose(client, args.instrument_key, credential)
    print("UPSTOX_SANITIZED_DIAGNOSTIC=" + json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(main())
