"""Closed disposable-rehearsal client compatibility check; no process/network I/O."""
import re

PG_DUMP = '/usr/lib/postgresql/16/bin/pg_dump'
PG_RESTORE = '/usr/lib/postgresql/16/bin/pg_restore'


def require_compatible_clients(server_major, dump_version, restore_version):
    if type(server_major) is not int or server_major != 16:
        raise ValueError('Stage18 requires the reviewed PostgreSQL16 server')
    versions = {}
    for tool, output in [('pg_dump', dump_version), ('pg_restore', restore_version)]:
        if type(output) is not str or len(output) > 512:
            raise ValueError('Bounded PostgreSQL client identity required')
        match = re.fullmatch(re.escape(tool)+r' \(PostgreSQL\) (\d+)\.\d+(?:[^\r\n]*)\n?', output)
        if match is None or int(match.group(1)) != server_major:
            raise ValueError('PostgreSQL dump/restore major must match the reviewed server')
        versions[tool] = int(match.group(1))
    return {'server_major': server_major, 'client_majors': versions}
