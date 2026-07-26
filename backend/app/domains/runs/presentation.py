RUN_PROMPT_PREVIEW_CHARS = 280


def build_run_prompt_preview(prompt: str) -> str:
    normalized = " ".join(prompt.split())
    if len(normalized) <= RUN_PROMPT_PREVIEW_CHARS:
        return normalized
    return f"{normalized[:RUN_PROMPT_PREVIEW_CHARS].rstrip()}..."
