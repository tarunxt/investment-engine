"""Bound generic job/run bodies before FastAPI parses or invokes a handler."""
import json
from .resource_policy import MAX_BODY_BYTES


class ResourceBodyMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        root = scope.get("root_path", "").rstrip("/")
        if root and path.startswith(root + "/"):
            path = path[len(root):]
        if (scope.get("type") != "http" or scope.get("method") not in {"POST", "PUT", "PATCH"}
                or path.rstrip("/") not in {"/jobs", "/runs"}):
            return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > MAX_BODY_BYTES:
                payload = json.dumps({"detail": "Request exceeds 4194304 bytes (4 MiB); reduce the request"}).encode()
                await send({"type": "http.response.start", "status": 413,
                            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode())]})
                await send({"type": "http.response.body", "body": payload})
                return
            body.extend(chunk)
            if not message.get("more_body", False):
                break
        delivered = False
        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()
        return await self.app(scope, bounded_receive, send)
