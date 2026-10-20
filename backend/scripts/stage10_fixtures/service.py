"""Stage10 CI service fixture; its readiness flag lives beside the installed file."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys
import time


def make_server(port, *, readiness=None, directory=None):
    directory=Path(directory) if directory is not None else Path(__file__).resolve().parent
    app_endpoint=port in {8002,3002} if readiness is None else readiness
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            failed=app_endpoint and (directory/'readiness-fail').exists()
            self.send_response(503 if failed else 200);self.end_headers()
            self.wfile.write(b'{"synthetic-ci-certificate":true}' if port==18082 else b'CI fixture only')
        def log_message(self,*args):pass
    return HTTPServer(('127.0.0.1',port),Handler)


def main():
    port=int(sys.argv[1])
    if not port:
        while True:time.sleep(10)
    make_server(port).serve_forever()


if __name__=='__main__':main()
