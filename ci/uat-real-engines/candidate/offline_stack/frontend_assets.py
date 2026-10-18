"""Serve only a reviewed local Next export behind OwnerBarrier."""
import base64
import hashlib
from html.parser import HTMLParser
from pathlib import Path


class Scripts(HTMLParser):
    def __init__(self):super().__init__(convert_charrefs=False);self.inside=False;self.parts=[];self.scripts=[]
    def handle_starttag(self,tag,attrs):
        if tag=='script':self.inside=True;self.parts=[]
    def handle_data(self,data):
        if self.inside:self.parts.append(data)
    def handle_endtag(self,tag):
        if tag=='script' and self.inside:
            self.scripts.append(''.join(self.parts));self.inside=False


def export_policy(directory):
    directory=Path(directory)
    if not (directory/'index.html').is_file():raise ValueError('Next export unavailable')
    hashes=set()
    files=list(directory.rglob('*.html'))
    if len(files)>20:raise ValueError('export bound')
    for path in files:
        if path.stat().st_size>2*1024*1024:raise ValueError('export bound')
        parser=Scripts();parser.feed(path.read_text())
        hashes.update("'sha256-"+base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()+"'"
                      for script in parser.scripts if script)
    return ("default-src 'none'; script-src 'self' "+' '.join(sorted(hashes))+
            "; connect-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; "
            "form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
