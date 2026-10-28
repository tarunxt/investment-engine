"""Only owned request receipts in the existing disposable loopback preview.

No drill, erasure worker, full export binding, file access or external action.
"""
import re
from fastapi import APIRouter
from app.domains.public_service.router import router

NAMES={'privacy_history','privacy_request','privacy_status','privacy_cancel','private_account_download'}

def allowed(method,path):
    root='/account/operations/'
    return (method=='GET' and path in {root+'privacy-requests',root+'private-account-download'}
        or method=='POST' and path==root+'privacy-requests'
        or method=='GET' and re.fullmatch(root+r'privacy-requests/[a-f0-9-]{36}',path) is not None
        or method=='POST' and re.fullmatch(root+r'privacy-requests/[a-f0-9-]{36}/cancel',path) is not None)

def install(app):app.include_router(APIRouter(routes=[route for route in router.routes if route.endpoint.__name__ in NAMES]))
