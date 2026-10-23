import unittest
from scripts.public_launch.stage18_postgres_tools import require_compatible_clients


class PostgresTools(unittest.TestCase):
    def test_official_debian_pg16_clients_match_server16(self):
        result = require_compatible_clients(16, 'pg_dump (PostgreSQL) 16.6 (Debian 16.6-1.pgdg12+1)\n',
            'pg_restore (PostgreSQL) 16.6 (Debian 16.6-1.pgdg12+1)\n')
        self.assertEqual(result['client_majors'], {'pg_dump': 16, 'pg_restore': 16})

    def test_bookworm_default_pg15_client_rejected(self):
        with self.assertRaises(ValueError):
            require_compatible_clients(16, 'pg_dump (PostgreSQL) 15.8\n', 'pg_restore (PostgreSQL) 15.8\n')

    def test_mixed_client_versions_rejected(self):
        with self.assertRaises(ValueError):
            require_compatible_clients(16, 'pg_dump (PostgreSQL) 16.6\n', 'pg_restore (PostgreSQL) 15.8\n')

    def test_unreviewed_server_and_boolean_rejected(self):
        for server in (15, 17, True, '16'):
            with self.subTest(server=server), self.assertRaises(ValueError):
                require_compatible_clients(server, 'pg_dump (PostgreSQL) 16.6', 'pg_restore (PostgreSQL) 16.6')

    def test_wrong_tool_multiline_or_malformed_identity_rejected(self):
        for output in ('pg_restore (PostgreSQL) 16.6', 'pg_dump (PostgreSQL) 16.6\nextra', '16.6', ''):
            with self.subTest(output=output), self.assertRaises(ValueError):
                require_compatible_clients(16, output, 'pg_restore (PostgreSQL) 16.6')
