"""Only systemd Unix-socket activation; no TCP listener or application environment."""
import os
import json
from importlib.metadata import version
from pathlib import Path
import socket
import sys


DEPENDENCIES = {'fastapi':'0.136.1','SQLAlchemy':'2.0.49','asyncpg':'0.30.0','uvicorn':'0.46.0'}


def verify_dependencies():
    try:
        if any(version(name) != expected for name, expected in DEPENDENCIES.items()):
            raise ValueError()
    except Exception:
        raise SystemExit('Viewer dependency fingerprint differs from the reviewed runtime') from None


def main():
    try:
        if int(os.environ.get('LISTEN_PID', '0')) != os.getpid() or os.environ.get('LISTEN_FDS') != '1':
            raise ValueError()
        with socket.socket(fileno=os.dup(3)) as listener:
            if listener.family != socket.AF_UNIX or not listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN):
                raise ValueError()
        verify_dependencies()
        directory = Path(os.environ['CREDENTIALS_DIRECTORY'])
        dsn = (directory / 'database-url').read_text().strip()
        def unique(pairs):
            if len({key for key,_ in pairs})!=len(pairs): raise ValueError()
            return dict(pairs)
        policy=json.loads((directory / 'temporary-database-policy').read_text(),object_pairs_hook=unique)
        if not isinstance(policy,dict) or set(policy)!={'approved_other_database'}: raise ValueError()
        other_database=policy['approved_other_database']
        if not dsn.startswith('postgresql+asyncpg://'):
            raise ValueError()
    except (ValueError, KeyError, OSError):
        raise SystemExit('Viewer private socket/credential configuration unavailable') from None
    # Imports only verified third-party packages and this immutable artifact.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        from browser import Store, make_app
        import uvicorn
        store = Store(dsn,approved_other_database=other_database)
    except Exception:
        raise SystemExit('Viewer database configuration unavailable') from None
    uvicorn.run(make_app(store), fd=3, workers=1, access_log=False, server_header=False, proxy_headers=False)


if __name__ == '__main__':
    main()
