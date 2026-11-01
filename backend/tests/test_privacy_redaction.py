"""Synthetic-only regression tests, runnable without application settings or DB."""
import ast
import io
import hashlib
import json
from types import SimpleNamespace
import logging
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.core.redaction import RedactingFormatter, redact_sensitive_text


class PrivacyRedactionTests(unittest.TestCase):
    def test_credential_patterns_preserve_diagnostics(self):
        cases = [
            'rediss://synthetic-user:synthetic-password@cache.invalid:6379/0',
            'postgresql+asyncpg://synthetic-user:synthetic-password@db.invalid/app',
            'https://api.invalid/path?api_key=synthetic-password&retry=2',
            'Authorization: Bearer synthetic-password',
            '{"password": "synthetic-password with spaces", "status": 503}',
            "token='synthetic-password with spaces' retry=2",
        ]
        for value in cases:
            with self.subTest(value=value):
                result = redact_sensitive_text(value)
                self.assertNotIn('synthetic-password', result)
                self.assertNotIn('synthetic-user', result)
                self.assertIn('[REDACTED]', result)
        self.assertIn('cache.invalid:6379/0', redact_sensitive_text(cases[0]))
        self.assertIn('retry=2', redact_sensitive_text(cases[2]))
        self.assertEqual(redact_sensitive_text('job=42 status=503 retry=2'), 'job=42 status=503 retry=2')

    def test_formatted_arguments_exception_and_two_handlers(self):
        logger = logging.Logger('synthetic')
        streams = [io.StringIO(), io.StringIO()]
        for stream in streams:
            handler = logging.StreamHandler(stream)
            handler.setFormatter(RedactingFormatter('%(levelname)s %(message)s'))
            logger.addHandler(handler)
        try:
            raise ValueError('redis://synthetic-user:synthetic-password@cache.invalid/0')
        except ValueError:
            logger.exception('job=%s Authorization: Bearer %s', 42, 'synthetic-token')
        for stream in streams:
            output = stream.getvalue()
            for secret in ('synthetic-user', 'synthetic-password', 'synthetic-token'):
                self.assertNotIn(secret, output)
            for diagnostic in ('job=42', 'ValueError', 'Traceback', 'cache.invalid/0'):
                self.assertIn(diagnostic, output)

    def test_underscore_credentials_in_assignments_and_mapping_values(self):
        names = ('JWT_SIGNING_KEY', 'JWT_SECRET', 'SECRET_KEY', 'OPENAI_API_KEY')
        for name in names:
            sentinel = f'synthetic-sentinel-{name.lower()}'
            cases = (
                f'{name}={sentinel} job=42',
                f'{name.lower()}: "{sentinel} with spaces" status=503',
                str({name: sentinel, 'job': 42}),
                json.dumps({'credentials': {name: sentinel}, 'status': 503}),
            )
            for value in cases:
                with self.subTest(name=name, value=value):
                    output = redact_sensitive_text(value)
                    self.assertNotIn(sentinel, output)
                    self.assertIn(name.lower(), output.lower())
                    self.assertIn('[REDACTED]', output)
            self.assertEqual(redact_sensitive_text(f'{name}={sentinel} job=42'),
                             f'{name}=[REDACTED] job=42')
        safe = 'job=42 status=503 retry=2 token_count=123 secret_hash=abc key_id=7'
        self.assertEqual(redact_sensitive_text(safe), safe)

    def test_underscore_credentials_at_every_configured_handler_output(self):
        # Read configuration syntax only; never import application settings.
        path = Path(__file__).resolve().parents[1] / 'app/core/logging.py'
        tree = ast.parse(path.read_text())
        assignment = next(node for node in tree.body if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Name) and target.id == 'LOGGING_CONFIG' for target in node.targets))
        config = eval(compile(ast.Expression(assignment.value), str(path), 'eval'),
                      {'settings': SimpleNamespace(log_level='INFO')})
        logger = logging.Logger('synthetic-underscore')
        streams = {}
        for name, handler_config in config['handlers'].items():
            stream = streams[name] = io.StringIO()
            handler = logging.StreamHandler(stream)
            formatter_config = config['formatters'][handler_config['formatter']]
            self.assertEqual(formatter_config['()'], 'app.core.redaction.RedactingFormatter')
            handler.setFormatter(RedactingFormatter(formatter_config['format']))
            logger.addHandler(handler)
        names = ('JWT_SIGNING_KEY', 'JWT_SECRET', 'SECRET_KEY', 'OPENAI_API_KEY')
        sentinels = [f'synthetic-output-sentinel-{name.lower()}' for name in names]
        for name, sentinel in zip(names, sentinels):
            logger.info('assignment %s=%s job=42', name, sentinel)
            logger.info('mapping %s job=42', {name: sentinel})
            logger.info('named %s=%%(credential)s job=42' % name, {'credential': sentinel})
            try:
                raise ValueError(f'{name}={sentinel} status=503')
            except ValueError:
                logger.exception('exception job=42')
        for name, stream in streams.items():
            with self.subTest(handler=name):
                output = stream.getvalue()
                for sentinel in sentinels:
                    self.assertNotIn(sentinel, output)
                for diagnostic in ('assignment', 'mapping', 'named', 'job=42', 'status=503', 'ValueError', 'Traceback'):
                    self.assertIn(diagnostic, output)
                self.assertGreaterEqual(output.count('[REDACTED]'), 16)

    def test_all_configured_handlers_use_redacting_formatter(self):
        path = Path(__file__).resolve().parents[1] / 'app/core/logging.py'
        tree = ast.parse(path.read_text())
        assignment = next(node for node in tree.body if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Name) and target.id == 'LOGGING_CONFIG' for target in node.targets))
        config = eval(compile(ast.Expression(assignment.value), str(path), 'eval'),
                      {'settings': SimpleNamespace(log_level='INFO')})
        for handler in config['handlers'].values():
            self.assertEqual(config['formatters'][handler['formatter']]['()'],
                             'app.core.redaction.RedactingFormatter')

    def test_metering_hashes_synthetic_request_without_importing_app(self):
        path = Path(__file__).resolve().parents[1] / 'app/domains/api_usage/metering.py'
        tree = ast.parse(path.read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'content_hash')
        namespace = {'json': json, 'hashlib': hashlib}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), 'exec'), namespace)
        request = {'prompt': 'synthetic-private-input', 'model': 'synthetic-model'}
        digest = namespace['content_hash'](request)
        self.assertEqual(digest, hashlib.sha256(json.dumps(request, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest())
        self.assertEqual(len(digest), 64)
        self.assertNotIn(request['prompt'], digest)
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'ApiAttempt')
        initializer = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == '__init__')
        assignments = [node for node in ast.walk(initializer) if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Attribute) and target.attr == 'values' for target in node.targets)]
        values = assignments[0].value
        index = next(i for i, key in enumerate(values.keys) if isinstance(key, ast.Constant) and key.value == 'prompt_hash')
        self.assertEqual(ast.unparse(values.values[index]), 'content_hash(request)')

    def test_startup_does_not_log_connection_values(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'app/main.py').read_text())
        lifespan = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'lifespan')
        for node in ast.walk(lifespan):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 'logger':
                for argument in node.args:
                    if any(isinstance(child, ast.Attribute) and child.attr in ('redis_url', 'database_url') for child in ast.walk(argument)):
                        self.assertIsInstance(argument, ast.Call)
                        self.assertEqual(argument.func.id, 'bool')

if __name__ == '__main__':
    unittest.main()
