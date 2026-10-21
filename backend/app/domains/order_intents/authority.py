"""Request-local human-action capability; never serialized into Celery/outbox.

Only the authenticated confirmation handler enters this scope. Normal workers,
service callers and task headers do not have it. This is an application boundary,
not protection against a DBA or arbitrary code execution inside the API process.
"""
from contextvars import ContextVar
from contextlib import contextmanager
from .contracts import OrderDenied
_current=ContextVar('exact_human_order_confirmation',default=None)

@contextmanager
def authenticated_confirmation(user,intent_id,displayed_digest):
    if type(user.id)is not int or user.is_active is not True or user.is_verified is not True:raise OrderDenied('VERIFIED_AUTHENTICATED_USER_REQUIRED')
    token=_current.set({'owner':user.id,'intent':intent_id,'displayed':displayed_digest,'used':False})
    try:yield
    finally:_current.reset(token)

def consume_confirmation(owner,intent_id,displayed_digest):
    value=_current.get()
    if value is None or value['used'] or (value['owner'],value['intent'],value['displayed'])!=(owner,intent_id,displayed_digest):raise OrderDenied('AUTHENTICATED_HUMAN_ACTION_REQUIRED')
    value['used']=True
