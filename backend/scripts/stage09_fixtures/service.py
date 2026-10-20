"""Synthetic CI service endpoints, never installed by a deployment package."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys
import time

port=int(sys.argv[1])
if not port:
    while True:time.sleep(10)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        failed=port in {8002,3002} and Path('/opt/stage09-controller-ci/readiness-fail').exists()
        self.send_response(503 if failed else 200);self.end_headers()
        self.wfile.write(b'{"synthetic-ci-certificate":true}' if port==18082 else b'CI fixture only')
    def log_message(self,*args):pass

HTTPServer(('127.0.0.1',port),Handler).serve_forever()
