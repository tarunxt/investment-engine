"""Retry signals never replay an effect or reuse an aborted transaction."""
from sqlalchemy.exc import DBAPIError


def serialization_conflict(error):
    return isinstance(error,DBAPIError) and getattr(error.orig,'pgcode',getattr(error.orig,'sqlstate',None))=='40001'
