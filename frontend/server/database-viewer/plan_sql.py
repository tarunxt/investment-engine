"""Offline review template only. Never connects to a database or accepts secrets."""
import json
from pathlib import Path
import re

ROOT = Path(__file__).parent
OWNER_PLACEHOLDER = '__PRIVATE_VERIFIED_OWNER_ID__'


def catalog():
    result = json.loads((ROOT / 'catalog.json').read_text())
    for relation in result['relations']:
        for name in [relation['relation'], *relation['columns'], *relation['policy_columns']]:
            if not re.fullmatch(r'[a-z][a-z0-9_]*', name):
                raise ValueError('Invalid catalog identifier')
        if relation['key'] != 'id' or 'id' not in relation['columns']:
            raise ValueError('A verified unique key is required')
    return result


def audit_sql():
    expected = [(item['relation'], column) for item in catalog()['relations']
                for column in sorted(set(item['columns'] + item['policy_columns']))]
    values = ', '.join("('%s','%s')" % pair for pair in expected)
    relations = ', '.join("'%s'" % item['relation'] for item in catalog()['relations'])
    return (ROOT / 'audit_template.sql').read_text().replace('__EXPECTED_COLUMN_VALUES__', values).replace('__EXPECTED_RELATIONS__', relations)


def review_sql():
    spec = catalog()
    lines = [
        '-- REVIEW TEMPLATE ONLY: invalid private placeholders deliberately prevent direct execution.',
        '-- Apply only after live relation/column/ownership and effective privilege review.',
        '-- Versioned native-viewer provisioning migration; no application data is modified.',
        'BEGIN;',
        "SET LOCAL lock_timeout = '500ms';",
        "SET LOCAL statement_timeout = '5s';",
        'CREATE ROLE credx_viewer_views NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;',
        'CREATE ROLE credx_viewer_read LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;',
        'CREATE SCHEMA credx_viewer AUTHORIZATION credx_viewer_views;',
        'REVOKE ALL ON SCHEMA credx_viewer FROM PUBLIC;',
        'GRANT USAGE ON SCHEMA public TO credx_viewer_views;',
        'GRANT USAGE ON SCHEMA credx_viewer TO credx_viewer_read;',
        'GRANT CONNECT ON DATABASE __VERIFIED_DATABASE_IDENTIFIER__ TO credx_viewer_read;',
        "ALTER ROLE credx_viewer_read SET default_transaction_read_only = on;",
        "ALTER ROLE credx_viewer_read SET statement_timeout = '3s';",
        "ALTER ROLE credx_viewer_read SET lock_timeout = '500ms';",
        "ALTER ROLE credx_viewer_read SET idle_in_transaction_session_timeout = '5s';",
    ]
    for item in spec['relations']:
        name = item['relation']
        columns = sorted(set(item['columns'] + item['policy_columns']))
        lines.append('GRANT SELECT (' + ', '.join('"'+c+'"' for c in columns) + ') ON public."'+name+'" TO credx_viewer_views;')
    for item in spec['relations']:
        name = item['relation']
        selected = ', '.join('t."'+c+'"' for c in item['columns'])
        lines += [
            f'CREATE VIEW credx_viewer."{name}" WITH (security_barrier=true) AS SELECT {selected} FROM public."{name}" t WHERE '+item['ownership'].format(owner_id=OWNER_PLACEHOLDER)+';',
            f'ALTER VIEW credx_viewer."{name}" OWNER TO credx_viewer_views;',
            f'REVOKE ALL ON credx_viewer."{name}" FROM PUBLIC;',
            f'GRANT SELECT ON credx_viewer."{name}" TO credx_viewer_read;',
        ]
    lines.append(audit_sql())
    lines += [
        '-- Mandatory in-transaction effective privilege audit before COMMIT:',
        '-- reject any membership/SET ROLE path, base-table/column access, persistent writes,',
        '-- schema/database CREATE, database TEMP, unsafe executable security-definer functions.',
        '-- A PUBLIC-derived privilege cannot be denied by revoking it from this role alone.',
        '-- If the audit fails, ROLLBACK; do not globally revoke PUBLIC or alter other services.',
        '-- No password, credential generation, existing-object replacement, CASCADE or DROP here.',
        'ROLLBACK; -- review template never commits',
    ]
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    print(review_sql(), end='')
