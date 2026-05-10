from __future__ import annotations

from openai import OpenAI

from app.core.config import settings
from app.providers.base import AIProviderResponse, BaseAIProvider


# DeepSeek pricing per 1M tokens (as of 2024-2025)
# Note: DeepSeek is known for being very cost-effective
DEEPSEEK_PRICING_PER_1M_TOKENS = {
    "deepseek-chat": {"input": 0.14, "output": 0.28},      # DeepSeek-V3
    "deepseek-reasoner": {"input": 0.14, "output": 0.28},  # DeepSeek-R1
}


class DeepSeekProvider(BaseAIProvider):
    provider_name = "deepseek"
    supported_models = ["deepseek-chat", "deepseek-reasoner"]

    @classmethod
    def is_configured(cls) -> bool:
        return bool(settings.deepseek_api_key)

    def __init__(self) -> None:
        if not settings.deepseek_api_key:
            raise ValueError("DEEPSEEK_API_KEY is not configured")

        # DeepSeek uses OpenAI-compatible API
        self.client = OpenAI(
            api_key=settings.deepseek_api_key,
            base_url=settings.deepseek_api_base or "https://api.deepseek.com/v1",
        )

    def generate(self, *, prompt: str, model: str) -> AIProviderResponse:
        """Generate response from DeepSeek API"""
        
        # Validate model
        if model not in self.supported_models:
                model = "deepseek-chat"  # fallback to default

        kwargs = {
            "model": model,
            "messages": [
                {"role": "user", "content": prompt},
            ],
        }

        if model == "deepseek-reasoner":
            kwargs["reasoning_effort"] = "high"
            kwargs["extra_body"] = {
                "thinking": {"type": "enabled"}
            }

        response = self.client.chat.completions.create(**kwargs)
        
        # Extract usage information
        usage = getattr(response, "usage", None)
        tokens_in = getattr(usage, "prompt_tokens", 0) or 0
        tokens_out = getattr(usage, "completion_tokens", 0) or 0
        
        # Extract response content
        choices = getattr(response, "choices", []) or []
        content = ""
        if choices:
            message = getattr(choices[0], "message", None)
            content = getattr(message, "content", "") or ""
        
        # Optional: Extract reasoning content for DeepSeek-R1
        reasoning_content = ""
        if model == "deepseek-reasoner" and choices:
            message = getattr(choices[0], "message", None)
            reasoning_content = getattr(message, "reasoning_content", "") or ""
            
            # If you want to include reasoning in response
            if reasoning_content:
                content = f"<thinking>\n{reasoning_content}\n</thinking>\n\n{content}"
        
        return AIProviderResponse(
            content=content.strip(),
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost=self._estimate_cost(model=model, tokens_in=tokens_in, tokens_out=tokens_out),
            provider=self.provider_name,
            model=model,
        )

    @staticmethod
    def _estimate_cost(*, model: str, tokens_in: int, tokens_out: int) -> float:
        """Estimate cost based on DeepSeek's pricing"""
        
        pricing = DEEPSEEK_PRICING_PER_1M_TOKENS.get(model)
        
        if not pricing:
            return 0.0
        
        estimated_cost = (
            (tokens_in / 1_000_000) * pricing["input"]
            + (tokens_out / 1_000_000) * pricing["output"]
        )
        return round(estimated_cost, 6)
    
    def generate_stream(self, *, prompt: str, model: str):
        """Optional: Stream responses from DeepSeek"""
        
        if model not in self.supported_models:
            model = "deepseek-chat"
        
        stream = self.client.chat.completions.create(
            model=model,
            messages=[
                {"role": "user", "content": prompt},
            ],
            stream=True,
        )
        
        for chunk in stream:
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content


# Alternative implementation using requests directly (if you don't want to use OpenAI SDK)
class DeepSeekDirectProvider(BaseAIProvider):
    """DeepSeek provider using direct HTTP requests"""
    
    provider_name = "deepseek"
    supported_models = ["deepseek-chat", "deepseek-coder", "deepseek-reasoner"]
    
    @classmethod
    def is_configured(cls) -> bool:
        return bool(settings.deepseek_api_key)
    
    def __init__(self) -> None:
        import requests
        
        if not settings.deepseek_api_key:
            raise ValueError("DEEPSEEK_API_KEY is not configured")
        
        self.api_key = settings.deepseek_api_key
        self.base_url = settings.deepseek_api_base or "https://api.deepseek.com/v1"
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        })
    
    def generate(self, *, prompt: str, model: str) -> AIProviderResponse:
        import requests
        
        if model not in self.supported_models:
            model = "deepseek-chat"
        
        payload = {
            "model": model,
            "messages": [
                {"role": "user", "content": prompt},
            ],
            "stream": False,
        }
        
        response = self.session.post(
            f"{self.base_url}/chat/completions",
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        
        tokens_in = data.get("usage", {}).get("prompt_tokens", 0)
        tokens_out = data.get("usage", {}).get("completion_tokens", 0)
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        
        return AIProviderResponse(
            content=content.strip(),
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost=self._estimate_cost(model=model, tokens_in=tokens_in, tokens_out=tokens_out),
            provider=self.provider_name,
            model=model,
        )
    
    @staticmethod
    def _estimate_cost(*, model: str, tokens_in: int, tokens_out: int) -> float:
        pricing = DEEPSEEK_PRICING_PER_1M_TOKENS.get(model, {"input": 0.14, "output": 0.28})
        estimated_cost = (
            (tokens_in / 1_000_000) * pricing["input"]
            + (tokens_out / 1_000_000) * pricing["output"]
        )
        return round(estimated_cost, 6)