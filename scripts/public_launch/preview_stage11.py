"""Mount real manual-import handlers only inside the already network-denied preview."""
import os,re
if os.environ.get('STAGE01_PREVIEW')!='synthetic-only':raise RuntimeError('Local synthetic preview only')
from fastapi import APIRouter
from app.domains.indmoney_us.router import router

def allowed(method,path):
    return (method,path) in {('GET','/indmoney-us/imports/template'),('POST','/indmoney-us/imports/preview')} or method=='POST' and re.fullmatch('/indmoney-us/imports/[1-9][0-9]*/accept',path) is not None

def install(app):
    for route in router.routes:
        if route.endpoint.__name__ in {'import_template','preview_import','accept_import'}:app.include_router(APIRouter(routes=[route]))
