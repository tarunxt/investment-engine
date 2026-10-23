"""Bounded owned scan references/page metadata via trusted directory handles.

Source contract: engine uses the persisted run ID as ScanPageCache run_key;
source-v1 segments contain pack identity/offset/length/content digest. We verify
segments but never decompress or export opaque payloads, claim exclusive pack
ownership, scan foreign directories, delete files or fetch missing market data.
"""
import hashlib,os,re,stat
from sqlalchemy import select,case,cast,Text,LargeBinary,func
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord as Run
from app.domains.ai_limits.contracts import BoundaryDenied
from .sql_account import _json_value
from .store import owner

REFERENCE=re.compile(r'^source-v1:([a-f0-9]{32}):(\d{1,12}):(\d{1,12}):([a-f0-9]{64})$')
PAGE=re.compile(r'^[a-f0-9]{64}\.json\.gz$')
LIMIT=8*1024*1024


def directory(fd):
    if type(fd) is not int or not stat.S_ISDIR(os.fstat(fd).st_mode):raise BoundaryDenied('TRUSTED_SCAN_DIRECTORY_REQUIRED')


def open_file(fd,name):
    try:child=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
    except OSError:raise BoundaryDenied('SCAN_STORE_FILE_UNAVAILABLE') from None
    shape=os.fstat(child)
    if not stat.S_ISREG(shape.st_mode) or shape.st_nlink!=1:
        os.close(child);raise BoundaryDenied('SCAN_STORE_UNSAFE_FILE')
    return child,shape


def references(value):
    if type(value) is dict:
        for item in value.values():yield from references(item)
    elif type(value) is list:
        for item in value:yield from references(item)
    elif type(value) is str and value.startswith('source-v1:'):
        match=REFERENCE.fullmatch(value)
        if match is None:raise BoundaryDenied('SCAN_REFERENCE_INVALID')
        yield match.groups()


def scan_inventory(db,subject,*,source_directory_fd,page_directory_fd):
    owner(db,subject,verified=True);directory(source_directory_fd);directory(page_directory_fd)
    dialect=db.get_bind().dialect.name
    if dialect=='postgresql' and db.connection().get_isolation_level() not in {'REPEATABLE READ','SERIALIZABLE'}:
        raise BoundaryDenied('ACCOUNT_SCAN_SNAPSHOT_REQUIRED')
    length=func.octet_length(cast(Run.payload,Text)) if dialect=='postgresql' else func.length(cast(Run.payload,LargeBinary))
    statement=select(Run.id,case((length>65536,None),else_=cast(Run.payload,Text))).where(Run.user_id==subject).order_by(Run.id).limit(101)
    result=[];used=0
    with db.execute(statement.execution_options(stream_results=True,yield_per=1)).yield_per(1) as rows:
        for run_id,raw in rows:
            if len(result)>=100 or raw is None:raise BoundaryDenied('SCAN_INVENTORY_LIMIT')
            value=_json_value(raw,65536);segments=[]
            for identity,offset,size,expected in sorted(set(references(value))):
                offset=int(offset);size=int(size);used+=size
                if size<1 or used>LIMIT or len(segments)>=1000:raise BoundaryDenied('SCAN_INVENTORY_LIMIT')
                fd,before=open_file(source_directory_fd,identity+'.pack')
                try:
                    if offset+size>before.st_size:raise BoundaryDenied('SCAN_SEGMENT_INCOMPLETE')
                    data=os.pread(fd,size,offset);after=os.fstat(fd)
                    if len(data)!=size or hashlib.sha256(data).hexdigest()!=expected or (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):
                        raise BoundaryDenied('SCAN_SEGMENT_CHANGED')
                finally:os.close(fd)
                segments.append({'size_bytes':size,'sha256':expected,'opaque_contents_exported':False})
            pages=[];name=hashlib.sha256(run_id.encode()).hexdigest()
            try:run_fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_DIRECTORY,dir_fd=page_directory_fd)
            except FileNotFoundError:run_fd=None
            except OSError:raise BoundaryDenied('SCAN_STORE_UNSAFE_DIRECTORY') from None
            if run_fd is not None:
                try:
                    with os.scandir(run_fd) as entries:
                        for entry in entries:
                            if len(pages)>=1000 or not PAGE.fullmatch(entry.name):raise BoundaryDenied('SCAN_INVENTORY_LIMIT')
                            fd,before=open_file(run_fd,entry.name);used+=before.st_size
                            try:
                                if used>LIMIT:raise BoundaryDenied('SCAN_INVENTORY_LIMIT')
                                checksum=hashlib.sha256();count=0
                                while True:
                                    data=os.read(fd,min(65536,LIMIT+1-count))
                                    if not data:break
                                    count+=len(data)
                                    if count>LIMIT:raise BoundaryDenied('SCAN_INVENTORY_LIMIT')
                                    checksum.update(data)
                                after=os.fstat(fd)
                                if count!=before.st_size or (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise BoundaryDenied('SCAN_SEGMENT_CHANGED')
                                pages.append({'sha256':checksum.hexdigest(),'size_bytes':count})
                            finally:os.close(fd)
                finally:os.close(run_fd)
            result.append({'run_id':run_id,'segments':segments,'pages':sorted(pages,key=lambda item:item['sha256'])})
    return {'owner_id':subject,'runs':result,'deletable':False,'opaque_contents_exported':False,
        'exclusive_pack_ownership_proven':False,'filesystem_atomic_with_sql':False,'complete_account_export':False}
