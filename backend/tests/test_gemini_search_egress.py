"""Unmediated native grounding cannot bypass the public-query dispatcher."""
import os
from types import SimpleNamespace as NS
import pytest


@pytest.mark.parametrize('prefix',['','[STAGE2_SHARED_EVIDENCE_ONLY]','[REBALANCE_TABLE_REPAIR]','[STOCK_TABLE_REPAIR]'])
def test_original_analysis_preserved_without_native_search_or_private_metadata(monkeypatch,prefix):
    if os.environ.get('A9_CONSUMER_GUARDED')!='1':
        pytest.skip('Use guarded consumer runner')
    from app.domains.ai_providers import gemini
    captured=[]
    prompt=prefix+' Synthetic private account fixture; holdings 12; cost_basis 999. Original instructions.'
    chunk=NS(text='Original analysis; source claim unverified.',usage_metadata=NS(
        prompt_token_count=12,candidates_token_count=5,tool_use_prompt_token_count=3),
        candidates=[NS(grounding_metadata=NS(web_search_queries=['Synthetic private account fixture'],
            grounding_chunks=[NS(web=NS(uri='https://example.invalid/unadmitted',title='unadmitted'))]))])
    def stream(**kwargs):
        captured.append(kwargs)
        yield chunk
    class Attempt:
        values={'attempt_id':'synthetic-attempt'}
        def __init__(self,**kwargs): pass
        def __enter__(self): return self
        def __exit__(self,*args): return False
        def observe(self,value): assert value is chunk
    monkeypatch.setattr(gemini,'ApiAttempt',Attempt)
    provider=gemini.GeminiProvider.__new__(gemini.GeminiProvider)
    provider.client=NS(models=NS(generate_content_stream=stream))
    result=provider._generate_once(prompt=prompt,model='gemini-2.5-flash')
    assert captured[0]['config'].tools is None
    assert captured[0]['contents'][0].parts[0].text==prompt
    assert result.content==chunk.text
    assert result.tokens_in==12 and result.tokens_out==5
    assert result.web_search_used is False
    assert result.web_search_queries==[] and result.web_sources==[]
