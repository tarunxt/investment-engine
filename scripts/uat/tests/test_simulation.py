from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'backend'))
from app.uat.simulation import SyntheticBroker, SyntheticEmailSink, synthetic_ai


class SimulationTests(unittest.TestCase):
    def setUp(self):
        self.config = {'environment': 'uat', 'adapter': 'synthetic-v1'}
        self.broker = SyntheticBroker(self.config)
        self.order = dict(request_id='fixture-1', symbol='SYNTHETIC-INDEX', side='buy', quantity=2)

    def test_real_or_extra_configuration_rejected(self):
        for extra in [{'environment': 'production'}, {'adapter': 'real'},
                      {'endpoint': 'https://broker.invalid'}, {'token': 'fake-fixture-token'}]:
            with self.assertRaises(ValueError):
                SyntheticBroker(self.config | extra)

    def test_deterministic_and_retry_safe(self):
        first = self.broker.submit(**self.order)
        self.assertIs(first, self.broker.submit(**self.order))
        self.assertEqual(first, SyntheticBroker(self.config).submit(**self.order))
        self.assertTrue(first.simulation)
        self.assertTrue(first.order_id.startswith('synthetic-'))
        with self.assertRaises(ValueError):
            self.broker.submit(**(self.order | {'quantity': 3}))

    def test_real_symbols_and_invalid_requests_rejected(self):
        for patch in [{'symbol': 'AAPL'}, {'side': 'transfer'}, {'quantity': True},
                      {'quantity': 0}, {'quantity': 101}, {'request_id': '../escape'}]:
            with self.assertRaises(ValueError):
                self.broker.submit(**(self.order | patch))

    def test_all_adapters_work_with_network_forbidden(self):
        with patch('socket.socket', side_effect=AssertionError('network forbidden')):
            self.broker.submit(**self.order)
            result = synthetic_ai('synthetic input')
            self.assertEqual(result['cost'], 0)
            self.assertEqual(result['provider'], 'synthetic')
            sent = SyntheticEmailSink().send('fixture@example.invalid', 'test', 'fixture')
            self.assertFalse(sent['delivered'])

    def test_memory_bounds(self):
        for i in range(1000):
            self.broker.submit(**(self.order | {'request_id': str(i)}))
        with self.assertRaises(ValueError):
            self.broker.submit(**(self.order | {'request_id': 'overflow'}))
        sink = SyntheticEmailSink()
        for i in range(1000):
            sink.send('fixture@example.invalid', 'test', 'fixture')
        with self.assertRaises(ValueError):
            sink.send('fixture@example.invalid', 'test', 'fixture')

    def test_oversized_inputs_are_rejected(self):
        with self.assertRaises(ValueError):
            synthetic_ai('x' * 4097)
        with self.assertRaises(ValueError):
            SyntheticEmailSink().send('fixture@example.invalid', 'test', 'x' * 4097)
