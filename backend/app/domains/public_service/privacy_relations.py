"""One source-backed relationship graph for privacy holds, order and effects.

The four audit relationships deliberately lack physical FKs. Provider account
identity on OrderIntent is an opaque external identity, not a SpendAccount FK.
Unrecognized reference spellings are refused instead of guessing their target.
"""
from dataclasses import dataclass,asdict
from app.domains.ai_limits.contracts import BoundaryDenied,digest
from .sql_account import _application_owner_table

APPLICATION_LINKS={
    'recommendation_verifications':(
        ('current_id','recommendation_decisions',False),
        ('previous_id','recommendation_decisions',True)),
    'recommendation_spend_attempts':(
        ('account_id','recommendation_spend_accounts',False),
        ('verification_id','recommendation_verifications',True)),
}
REFERENCE_NAMES=frozenset({'current_id','previous_id','account_id','verification_id'})

@dataclass(frozen=True,order=True)
class PrivacyRelation:
    child:str
    child_columns:tuple[str,...]
    parent:str
    parent_columns:tuple[str,...]
    kind:str

def _provider_identity(table,column):
    if (table.name,column)!=('confirmed_order_intents','account_id'):return False
    from app.domains.order_intents.models import OrderIntent
    expected=OrderIntent.__table__
    shape=lambda t: sorted((c.name,str(c.type),c.nullable) for c in t.columns)
    foreign=lambda t: sorted((e.parent.name,e.target_fullname) for c in t.foreign_key_constraints for e in c.elements)
    return shape(table)==shape(expected) and foreign(table)==foreign(expected)

def relationships(metadata):
    edges=[];known=set()
    for table in metadata.tables.values():
        for fk in table.foreign_key_constraints:
            elements=list(fk.elements)
            if not elements or len({e.column.table.name for e in elements})!=1:
                raise BoundaryDenied('PRIVACY_RELATIONSHIP_UNSUPPORTED')
            edges.append(PrivacyRelation(table.name,tuple(e.parent.name for e in elements),
                elements[0].column.table.name,tuple(e.column.name for e in elements),'physical_fk'))
    for child,links in APPLICATION_LINKS.items():
        if child not in metadata.tables:continue
        if not _application_owner_table(metadata.tables[child]):
            raise BoundaryDenied('PRIVACY_APPLICATION_RELATIONSHIP_SCHEMA_REQUIRED')
        for column,parent,optional in links:
            if parent not in metadata.tables or not _application_owner_table(metadata.tables[parent]):
                raise BoundaryDenied('PRIVACY_APPLICATION_RELATIONSHIP_SCHEMA_REQUIRED')
            edges.append(PrivacyRelation(child,(column,),parent,('id',),'application'))
            known.add((child,column))
    for table in metadata.tables.values():
        for column in REFERENCE_NAMES & set(table.c.keys()):
            if table.c[column].foreign_keys or (table.name,column) in known:continue
            if _provider_identity(table,column):continue
            raise BoundaryDenied('PRIVACY_RELATIONSHIP_UNSUPPORTED')
    if any(edge.parent not in metadata.tables for edge in edges):raise BoundaryDenied('PRIVACY_RELATIONSHIP_UNSUPPORTED')
    return tuple(sorted(set(edges)))

def relationship_hash(edges):return digest([asdict(edge) for edge in edges])
