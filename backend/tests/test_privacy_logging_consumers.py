"""Synthetic final-output sink regressions; no application settings are loaded."""
import io
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.core.redaction import RedactingFormatter


class ConsumerSinkTests(unittest.TestCase):
    def test_structured_telemetry_error_export_values_in_console_and_rotating_sink(self):
        marker = 'synthetic-sensitive-tail'
        # Escaped delimiters must not terminate a quoted sensitive value early.
        payloads = [json.dumps({'password': 'synthetic-prefix"' + marker, 'job': 42}),
                    repr({'SECRET_KEY': "synthetic-prefix'" + marker, 'status': 503}),
                    json.dumps({'export_error': {'token': 'synthetic-prefix"' + marker}, 'rows': 2}),
                    'Redis rediss://synthetic-user:synthetic-password@cache.invalid:6379/0 job=42']
        with tempfile.TemporaryDirectory() as directory:
            stream = io.StringIO()
            disk = Path(directory) / 'synthetic.log'
            handlers = [logging.StreamHandler(stream), RotatingFileHandler(disk, maxBytes=100000, backupCount=1)]
            logger = logging.Logger('synthetic-consumer')
            for handler in handlers:
                handler.setFormatter(RedactingFormatter('%(levelname)s %(message)s'))
                logger.addHandler(handler)
            try:
                for payload in payloads:
                    logger.error('telemetry/export diagnostic: %s', payload)
                try:
                    raise ValueError(payloads[0])
                except ValueError:
                    logger.exception('job=42 status=503 rows=2')
                for handler in handlers:
                    handler.flush()
                for output in (stream.getvalue(), disk.read_text()):
                    for sensitive in (marker, 'synthetic-user', 'synthetic-password'):
                        self.assertNotIn(sensitive, output, 'synthetic sensitive value reached sink')
                    for diagnostic in ('job=42', 'status=503', 'rows=2', 'ValueError', 'Traceback', 'cache.invalid:6379/0'):
                        self.assertIn(diagnostic, output)
            finally:
                for handler in handlers:
                    handler.close()

if __name__ == '__main__':
    unittest.main()
