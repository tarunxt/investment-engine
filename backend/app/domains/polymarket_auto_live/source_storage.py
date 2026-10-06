"""Local, non-destructive admission for immutable source packs.

All cooperating pack writers flush allocated bytes before releasing this lock.
The reserve is headroom, not a retention policy. No existing files are removed.
"""
from contextlib import contextmanager
import fcntl
import shutil


@contextmanager
def admit_source_write(directory, size, *, reserve_bytes=2 * 1024**3):
    with (directory / '.source-write.lock').open('a+b') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            if shutil.disk_usage(directory).free < size + reserve_bytes:
                raise OSError('STAGE_ONE_STORAGE_CAPACITY: Source write needs space plus a 2 GiB reserve. No existing source was deleted.')
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
