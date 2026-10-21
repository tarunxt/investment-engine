"""Synthetic encrypted recovery/rotation drills, reusing the versioned keyring.

Never reads host backups or configured keys, invokes pg_restore or replays jobs.
"""
from app.domains.connections.crypto import ConnectionKeyring,ConnectionFault
from app.domains.ai_limits.contracts import BoundaryDenied,digest


def seal_fixture(keyring,*,owner,source,document):
    if type(keyring)is not ConnectionKeyring or type(owner)is not int or owner<1 or document.get('synthetic')is not True or len(source)!=40 or any(c not in '0123456789abcdef' for c in source):raise BoundaryDenied('SYNTHETIC_BACKUP_REQUIRED')
    digest(document)
    ciphertext,version=keyring.seal({'owner_id':owner,'source':source,'synthetic':True,'document':document,'hash':digest(document)})
    return {'ciphertext':ciphertext,'version':version,'owner_id':owner,'source':source}


def restore_fixture(keyring,envelope,*,owner,source):
    if type(owner)is not int or owner<1 or not isinstance(source,str):raise BoundaryDenied('BACKUP_BINDING_CHANGED')
    try:p=keyring.open(envelope['ciphertext'],envelope['version'])
    except (ConnectionFault,KeyError):raise BoundaryDenied('BACKUP_UNREADABLE') from None
    if envelope.get('owner_id')!=owner or envelope.get('source')!=source or p.get('owner_id')!=owner or p.get('source')!=source or p.get('synthetic')is not True or digest(p.get('document'))!=p.get('hash'):raise BoundaryDenied('BACKUP_BINDING_CHANGED')
    return {'document':p['document'],'replay_orders':False,'resume_workflows':False,'requires_fresh_confirmation':True}


def rotate_fixture(old,new,envelope,*,owner,source):
    doc=restore_fixture(old,envelope,owner=owner,source=source)['document']
    return seal_fixture(new,owner=owner,source=source,document=doc)
