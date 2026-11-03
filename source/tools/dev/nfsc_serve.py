#!/usr/bin/env python3
"""Local server for the web build with the game files streamed from assets.nfscrb.xyz (LOCAL-TESTING.md, step 5).

    python tools/dev/nfsc_serve.py build/web-site kit/tools

The kit's isolated server (COOP/COEP headers) plus two routes:
- /remote/*               -> https://assets.nfscrb.xyz/* (Range forwarded; the CDN sends no CORS headers);
- /nfsc/custom-assets/*   -> the published customization assets (assetBase of kit/web/player/index.html).
"""
import functools
import http.server
import sys
import urllib.error
import urllib.request

sys.path.insert(0, sys.argv[2])
import web_launcher  # noqa: E402

UP = "https://assets.nfscrb.xyz/"
CUSTOM = "/remote/customization/5911a37d9f9bc652b3fa457127273970b0d2a5e0e87c7081fb789a2c05439dbc/"
# Cloudflare refuses Python's own User-Agent (error 1010).
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"


class H(web_launcher.IsolatedHandler):
    def _proxy(self, head=False):
        req = urllib.request.Request(UP + self.path[len("/remote/"):], method="HEAD" if head else "GET")
        req.add_header("User-Agent", UA)
        if self.headers.get("Range"):
            req.add_header("Range", self.headers["Range"])
        try:
            r = urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            r = e
        body = b"" if head else r.read()
        self.send_response(r.status if hasattr(r, "status") else r.code)
        for k in ("Content-Type", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"):
            if r.headers.get(k):
                self.send_header(k, r.headers[k])
        self.send_header("Content-Length", r.headers.get("Content-Length") if head else str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def _remote(self):
        if self.path.startswith("/nfsc/custom-assets/"):
            self.path = CUSTOM + self.path[len("/nfsc/custom-assets/"):]
        return self.path.startswith("/remote/")

    def do_GET(self):
        if self._remote():
            return self._proxy()
        super().do_GET()

    def do_HEAD(self):
        if self._remote():
            return self._proxy(True)
        super().do_HEAD()


with http.server.ThreadingHTTPServer(("127.0.0.1", 8000), functools.partial(H, directory=sys.argv[1])) as s:
    print("serving on http://localhost:8000/", flush=True)
    s.serve_forever()
