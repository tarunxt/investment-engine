"""Read-only canonical SQL composition; deliberately no deletion or HTTP binding.

A successful SQL snapshot does not prove external file/cache/backup coverage.
Shared audit blobs release only reference metadata, never opaque payloads.
"""
from sqlalchemy import select, exists, func
from app.domains.ai_limits.contracts import BoundaryDenied, digest
from .sql_account import _encode
from .canonical_privacy_inventory import assert_owned_relationships
from .canonical_privacy_resolvers import owned_execution_fences


def audit_blob_references(db, metadata, reader, subject):
    rules = {rule.table: rule for rule in reader.inventory.rules if not rule.excluded_reason}
    blobs = metadata.tables['bullpen_run_audit_blobs']
    references = []
    for table in metadata.tables.values():
        for column in table.c:
            if any(f.column.table is blobs for f in column.foreign_keys):
                rule = rules.get(table.name)
                if rule is None:
                    raise BoundaryDenied('ACCOUNT_BLOB_REFERENCE_UNCLASSIFIED')
                references.append((table, column, rule))
    predicates = [exists(select(1).select_from(table).where(column == blobs.c.id,
        reader._predicate(table, rule, subject))) for table, column, rule in references]
    if not predicates:
        raise BoundaryDenied('ACCOUNT_BLOB_REFERENCE_UNCLASSIFIED')
    from sqlalchemy import or_
    rows = db.execute(select(blobs.c.id, blobs.c.content_type, blobs.c.size_bytes)
        .where(or_(*predicates)).order_by(blobs.c.id).limit(1001)).all()
    if len(rows) > 1000:
        raise BoundaryDenied('ACCOUNT_EXPORT_SIZE_LIMIT')
    result = []
    for identifier, content_type, size in rows:
        # Opaque content can contain another principal even when all references
        # are owned. Do not infer payload ownership from sanitized=True or hashes.
        if (type(identifier) is not str or len(identifier) > 64 or
            type(content_type) is not str or len(content_type) > 128 or
            type(size) is not int or size < 0):
            raise BoundaryDenied('ACCOUNT_BLOB_METADATA_INVALID')
        shared = any(db.scalar(select(1).select_from(table).where(column == identifier,
            ~func.coalesce(reader._predicate(table, rule, subject), False)).limit(1)) is not None
            for table, column, rule in references)
        result.append({'id': identifier, 'payload_disposition': 'withheld_opaque_content',
            'shared_reference': shared,
            # Shared metadata can describe another principal's material.
            'content_type': None if shared else content_type,
            'size_bytes': None if shared else size})
    return {'items': result, 'payloads_exported': False, 'deletable': False}


class CanonicalAccountExport:
    def __init__(self, db, metadata, *, keyring=None, native_scope=None, cache_client=None, export_directory_fd=None):
        self.db, self.metadata = db, metadata
        self.keyring,self.native_scope=keyring,native_scope
        self.cache_client,self.export_directory_fd=cache_client,export_directory_fd

    def export(self, subject):
        reader = assert_owned_relationships(self.db, self.metadata, subject)
        sql = reader.export(subject)
        result = {'owner_id': subject, 'sql': sql,
            'audit_blobs': audit_blob_references(self.db, self.metadata, reader, subject),
            'execution_controls': owned_execution_fences(self.db, self.metadata, subject),
            'complete_account_export': False, 'complete_account_erasure': False,
            'runtime_binding': False,
            'dispositions': {
                'outbox': 'requires separately scoped typed topic adapters; unknown topics held',
                'files': 'unverified deployment inventory; no path supplied by account data is opened',
                'cache': 'unverified key ownership and persistence; no wildcard scan or deletion',
                'identity': 'export excludes credentials; identity revocation/erasure requires policy',
                'backups': 'inventory and expiry/restore suppression policy required',
                'retention': 'no periods or legal holds inferred from source classification'}}
        from .public_outbox_export import PublicOutboxExport
        result['public_outbox']=PublicOutboxExport(self.db).export(subject)
        if self.keyring is not None:
            from .encrypted_privacy_export import EncryptedPrivacyExport
            result['encrypted_ledger_metadata']=EncryptedPrivacyExport(self.db,self.keyring).export(subject)
        else:result['dispositions']['encrypted_ledger']='held: explicit caller-owned keyring required'
        if self.native_scope is not None:
            from .native_outbox_export import NativeOutboxExport
            result['native_outbox']=NativeOutboxExport(self.db,scope=self.native_scope).export(subject)
        else:result['dispositions']['native_outbox']='held: explicit simulation owner/environment scope required'
        if self.cache_client is not None:
            from .task_registry_export import export_job_registry
            result['job_task_registry']=export_job_registry(self.db,subject,self.cache_client)
        if self.export_directory_fd is not None:
            from .export_file_inventory import owned_export_files
            result['generated_file_metadata']=owned_export_files(self.db,subject,self.export_directory_fd)
        if len(_encode(result)) > 8 * 1024 * 1024 - 100:
            raise BoundaryDenied('ACCOUNT_EXPORT_SIZE_LIMIT')
        result['content_hash'] = digest(result)
        return result
