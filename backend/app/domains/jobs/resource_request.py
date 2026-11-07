"""Option A pure request preparation; no dispatch, certification or billing.

The integrator must atomically reserve the returned token/tool envelope and use a
qualified deadline boundary before dispatch. Setting an SDK inactivity timeout is
not absolute cancellation. This module never registers/activates an adapter.
"""
from .resource_policy import (MAX_OUTPUT_PER_JOB, MAX_OUTPUT_PER_RESPONSE, MAX_TOOLS_PER_JOB,
    MAX_TOOLS_PER_RESPONSE, REQUEST_SECONDS, ResourceBlocked, validate_provider_input)
import math

TOKEN_PARAMETERS = {
    "openai.responses": "max_output_tokens",
    "openai.chat": "max_completion_tokens",
    "deepseek.chat": "max_tokens",
    "anthropic.messages": "max_tokens",
}


def bounded_token_request(endpoint, kwargs, *, remaining_tokens, remaining_seconds, sdk_retries):
    if endpoint not in TOKEN_PARAMETERS:
        raise ResourceBlocked("Request endpoint has no qualified token parameter")
    if type(sdk_retries) is not int or sdk_retries != 0:
        raise ResourceBlocked("Hidden transport retries are not authorized")
    if type(remaining_tokens) is not int or not 0 < remaining_tokens <= MAX_OUTPUT_PER_JOB:
        raise ResourceBlocked("No verified original job output allowance")
    if type(remaining_seconds) not in (int, float) or not math.isfinite(remaining_seconds) or remaining_seconds <= 0:
        raise ResourceBlocked("No verified remaining original job deadline")
    validate_provider_input((), kwargs)
    parameter = TOKEN_PARAMETERS[endpoint]
    if any(name in kwargs for name in set(TOKEN_PARAMETERS.values()) - {parameter}):
        raise ResourceBlocked("Conflicting or unsupported output-token parameters")
    requested = kwargs.get(parameter, MAX_OUTPUT_PER_RESPONSE)
    if type(requested) is not int or requested <= 0:
        raise ResourceBlocked("Invalid output-token request bound")
    timeout = kwargs.get("timeout", REQUEST_SECONDS)
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
        raise ResourceBlocked("Unrecognized SDK timeout contract")
    result = dict(kwargs)
    result[parameter] = min(requested, remaining_tokens, MAX_OUTPUT_PER_RESPONSE)
    result["timeout"] = min(timeout, remaining_seconds, REQUEST_SECONDS)
    return result


def validate_tool_batch(calls, *, tools_already_reserved):
    """Check the whole response BEFORE exposing any call to a dispatcher."""
    if not isinstance(calls, (list, tuple)) or type(tools_already_reserved) is not int or tools_already_reserved < 0:
        raise ResourceBlocked("Tool consumption is not known")
    if len(calls) > MAX_TOOLS_PER_RESPONSE or tools_already_reserved + len(calls) > MAX_TOOLS_PER_JOB:
        raise ResourceBlocked("Original job tool allowance cannot cover this response")
    return tools_already_reserved + len(calls)


def remaining_reserved_output(current_reserved, call_reserved, reported_total):
    """Only complete generated-token usage (including reasoning) can free slots.

    No USD/INR settlement is inferred. A caller lacking complete usage must leave
    the original reservation held and suspend subsequent calls.
    """
    if any(type(value) is not int for value in (current_reserved, call_reserved, reported_total)):
        raise ResourceBlocked("Generated-token usage is incomplete")
    if not 0 <= reported_total <= call_reserved <= current_reserved <= MAX_OUTPUT_PER_JOB:
        raise ResourceBlocked("Generated-token usage conflicts with its reservation")
    return current_reserved - call_reserved + reported_total
