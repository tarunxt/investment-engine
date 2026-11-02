"""Exercise actual specialized provider-call functions with synthetic callbacks."""
import concurrent.futures
from contextvars import copy_context, ContextVar
from pathlib import Path
import re
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock

from app.domains.ai_providers.base import AIProviderResponse, ProviderCallError, build_provider_call_error
from test_execution_claim import claim
from test_postgresql_execution import load_nodes, ROOT


class SpecializedExecution(unittest.TestCase):
    def namespace(self, provider, owner):
        ns = {
            'copy_context': copy_context, 'concurrent': concurrent, 'time': time, 'random': SimpleNamespace(uniform=lambda *args: 0),
            'ProviderFactory': SimpleNamespace(create=lambda name: provider,
                validate_target=lambda *args: SimpleNamespace(available=True)),
            '_provider_semaphore': lambda name: threading.Semaphore(1),
            'BULLPEN_LLM_REQUEST_TIMEOUT_SECONDS': 0.02,
            'BULLPEN_LLM_MAX_REQUEST_ATTEMPTS': 3,
            'ProviderCallError': ProviderCallError, 'build_provider_call_error': build_provider_call_error,
            'BullpenProviderBatchCall': lambda **kwargs: SimpleNamespace(**kwargs),
            'REQUEST_RETRYABLE_PATTERNS': (re.compile('timeout'),),
            'REQUEST_NON_RETRYABLE_PATTERNS': (),
        }
        load_nodes(ROOT / 'app/domains/polymarket/bullpen_llm_execution.py', {
            '_call_provider_once_with_timeout', 'execute_provider_batch_call', '_is_retryable_request_error'}, ns)
        return ns

    def test_each_internal_call_has_before_and_after_fence(self):
        order = []
        owner = SimpleNamespace(before_call=lambda: order.append('before'),
                                after_call=lambda: order.append('after'))
        response = AIProviderResponse('synthetic', 1, 2, 0.0, 'synthetic', 'model')
        provider = SimpleNamespace(generate=lambda **kwargs: order.append('provider') or response)
        ns = self.namespace(provider, owner)
        for _ in range(2):
            ns['_call_provider_once_with_timeout']('synthetic', 'model', 'prompt', owner)
        self.assertEqual(['before', 'provider', 'after'] * 2, order)

    def test_usage_identity_context_survives_provider_thread(self):
        identity = ContextVar('synthetic_usage', default=None)
        identity.set('synthetic-attempt')
        observed = []
        provider = SimpleNamespace(generate=lambda **kwargs: observed.append(identity.get()))
        owner = SimpleNamespace(before_call=lambda: None, after_call=lambda: None)
        ns = self.namespace(provider, owner)
        ns['_call_provider_once_with_timeout']('synthetic', 'model', 'prompt', owner)
        self.assertEqual(['synthetic-attempt'], observed)

    def test_lost_owner_blocks_internal_call(self):
        provider = SimpleNamespace(generate=MagicMock())
        owner = SimpleNamespace(before_call=MagicMock(side_effect=claim.LostExecutionOwner('synthetic lost owner')))
        ns = self.namespace(provider, owner)
        with self.assertRaises(claim.LostExecutionOwner):
            ns['_call_provider_once_with_timeout']('synthetic', 'model', 'prompt', owner)
        provider.generate.assert_not_called()

    def test_ambiguous_internal_error_is_not_retried(self):
        provider = SimpleNamespace(generate=MagicMock(side_effect=TimeoutError('synthetic timeout')))
        owner = SimpleNamespace(before_call=MagicMock(), after_call=MagicMock(), block=MagicMock())
        ns = self.namespace(provider, owner)
        with self.assertRaises((TimeoutError, ProviderCallError)):
            ns['execute_provider_batch_call'](provider_name='synthetic', model_name='model', prompt='prompt', execution_ownership=owner)
        self.assertEqual(1, provider.generate.call_count)
        owner.after_call.assert_not_called()
        self.assertTrue(owner.block.called)

    def test_timeout_with_live_future_blocks_replay(self):
        release = threading.Event()
        finished = threading.Event()
        def generate(**kwargs):
            release.wait(3)
            finished.set()
            return AIProviderResponse('synthetic', 1, 1, 0.0, 'synthetic', 'model')
        provider = SimpleNamespace(generate=MagicMock(side_effect=generate))
        owner = SimpleNamespace(before_call=MagicMock(), after_call=MagicMock(), block=MagicMock())
        ns = self.namespace(provider, owner)
        try:
            with self.assertRaises(ProviderCallError):
                ns['execute_provider_batch_call'](provider_name='synthetic', model_name='model', prompt='prompt', execution_ownership=owner)
            self.assertEqual(1, provider.generate.call_count)
            self.assertTrue(owner.block.called)
        finally:
            release.set()
            self.assertTrue(finished.wait(3))

if __name__ == '__main__': unittest.main()
