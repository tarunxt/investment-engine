"""Conservative disposable export projection; no arbitrary-secret guarantee.

Credential fields remain excluded by the canonical reader. Unverified text,
JSON, binary and non-key string content is held until a reviewed typed content
projection exists. Identifiers, enum values, numeric and temporal fields retain
source ownership fences. This is deliberately not complete account export.
"""
from dataclasses import replace
from sqlalchemy import String,Text,JSON,LargeBinary,Enum
from .canonical_privacy_inventory import canonical_inventory


def safe_canonical_inventory(metadata,*,reference):
    inventory=canonical_inventory(metadata,reference=reference);rules=[]
    for rule in inventory.rules:
        if rule.excluded_reason:rules.append(rule);continue
        table=metadata.tables[rule.table];held=set(rule.withheld_columns)
        for name in rule.export_columns:
            column=table.c[name]
            if (isinstance(column.type,(Text,JSON,LargeBinary)) or
                isinstance(column.type,String) and not isinstance(column.type,Enum)
                and not column.primary_key and not column.foreign_keys):
                held.add(name)
        rules.append(replace(rule,export_columns=tuple(name for name in rule.export_columns if name not in held),
            withheld_columns=tuple(column.name for column in table.columns if column.name in held)))
    return replace(inventory,rules=tuple(rules))


def projection_manifest(metadata,*,reference):
    inventory=safe_canonical_inventory(metadata,reference=reference)
    return {'schema_digest':inventory.schema_digest,'complete_account_export':False,
        'complete_account_erasure':False,'runtime_binding':False,
        'datasets':{rule.table:{'export_columns':list(rule.export_columns),
            'withheld_columns':list(rule.withheld_columns),'retained_reason':rule.excluded_reason}
            for rule in inventory.rules},
        'limits':['unverified content held pending typed projection',
            'arbitrary unlabeled secrets inside identifiers are not certified',
            'shared payloads, identity and backup erasure remain unapproved']}
