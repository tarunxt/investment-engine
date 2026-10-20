"""Fresh selected/capable IDs for ordinary module-filtered read projections.

Explicit core activity/history and accepted-order safety routes are retained.
"""
from .service import describe
async def visible_module_ids(db,owner):
    data=await describe(db,owner)
    return [m['module_id'] for m in data['modules'] if m['selection']['enabled'] and m['availability']['available'] and m['capabilities'].get('view',{}).get('allowed')]
