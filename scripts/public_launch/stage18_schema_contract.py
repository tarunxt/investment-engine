"""Narrow PostgreSQL 16 CHECK deparser normalization for restore comparisons.

Only distribute a text[] cast across a nonempty ARRAY of unbounded varchar
ASCII enum literals in an entire `column::text = ANY (...)` expression. These
casts preserve every literal's value, order and multiplicity. Do not remove
casts generally, normalize identifiers/operators, or simplify arbitrary SQL.
Unknown expressions remain byte-for-byte unchanged (fail closed on drift).
"""
import re

_LITERAL = r"'[a-z_][a-z0-9_]*'::character varying"
_ARRAY_CHECK = re.compile(
    r"(?P<prefix>[a-z_][a-z0-9_]*::text = ANY \(ARRAY\[)"
    r"(?P<items>" + _LITERAL + r"(?:, " + _LITERAL + r")*)"
    r"\]::text\[\]\)"
)


def canonical_check_sql(sqltext: str) -> str:
    match = _ARRAY_CHECK.fullmatch(sqltext)
    if match is None:
        return sqltext
    return match['prefix'] + ', '.join(
        item + '::text' for item in match['items'].split(', ')
    ) + '])'
