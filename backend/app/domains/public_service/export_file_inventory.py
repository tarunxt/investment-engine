"""Owned generated XLSX metadata from exact producer names, never cached paths.

Caller supplies an already-open trusted export directory descriptor. No directory
scan, environment lookup, content export, deletion, queue or provider call occurs.
"""
import hashlib,os,stat
from sqlalchemy import select
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord
from app.domains.polymarket_auto_live.export_jobs import job_key
from .store import owner


def owned_export_files(db,subject,directory_fd):
    owner(db,subject,verified=True)
    if db.get_bind().dialect.name=='postgresql' and db.connection().get_isolation_level() not in {'REPEATABLE READ','SERIALIZABLE'}:
        raise BoundaryDenied('ACCOUNT_FILE_SNAPSHOT_REQUIRED')
    if type(directory_fd) is not int or not stat.S_ISDIR(os.fstat(directory_fd).st_mode):
        raise BoundaryDenied('TRUSTED_EXPORT_DIRECTORY_REQUIRED')
    identifiers=list(db.scalars(select(PolymarketAutoLiveRunRecord.id).where(
        PolymarketAutoLiveRunRecord.user_id==subject).order_by(PolymarketAutoLiveRunRecord.id).limit(501)))
    if len(identifiers)>500:raise BoundaryDenied('ACCOUNT_FILE_INVENTORY_LIMIT')
    result=[];total=0
    for identifier in identifiers:
        if type(identifier) is not str or not 1<=len(identifier)<=64:
            raise BoundaryDenied('ACCOUNT_FILE_OWNER_BINDING_REQUIRED')
        for scope in ('all-scanned','filtered'):
            name=job_key(subject,identifier,scope).rsplit(':',1)[-1]+'.xlsx'
            try:fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory_fd)
            except FileNotFoundError:continue
            except OSError:raise BoundaryDenied('ACCOUNT_FILE_UNSAFE') from None
            try:
                before=os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_size>8*1024*1024 or before.st_nlink!=1:
                    raise BoundaryDenied('ACCOUNT_FILE_UNSAFE')
                total+=before.st_size
                if total>8*1024*1024:raise BoundaryDenied('ACCOUNT_FILE_INVENTORY_LIMIT')
                checksum=hashlib.sha256();read=0
                while True:
                    data=os.read(fd,min(65536,8*1024*1024+1-read))
                    if not data:break
                    read+=len(data)
                    if read>8*1024*1024:raise BoundaryDenied('ACCOUNT_FILE_INVENTORY_LIMIT')
                    checksum.update(data)
                after=os.fstat(fd)
                if (before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns) or read!=after.st_size:
                    raise BoundaryDenied('ACCOUNT_FILE_CHANGED')
                result.append({'run_id':identifier,'scope':scope,'size_bytes':read,'sha256':checksum.hexdigest()})
            finally:os.close(fd)
    return {'owner_id':subject,'items':result,'contents_exported':False,'deletable':False,
        'filesystem_atomic_with_sql':False,'other_files_covered':False,'complete_account_export':False}
