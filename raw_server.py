"""Raw code download/upload - no MCP SSE 64KB limit
v2: incremental upload — never deletes existing files, only adds/overwrites
v2.1: security hardening — request size limit + repo name validation
"""
import os, re, subprocess, tempfile, time, shutil
from http.server import HTTPServer, BaseHTTPRequestHandler

REPO_BASE = os.environ.get("REPO_BASE", "/opt/mcp/repos")
PORT = int(os.environ.get("PORT", "3088"))
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50MB
REPO_NAME_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$')

def is_safe_repo(name: str) -> bool:
    return bool(REPO_NAME_RE.match(name))

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_error(self, code: int, msg: str = ""):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(msg)))
        self.end_headers()
        if msg:
            self.wfile.write(msg.encode())

    def do_GET(self):
        parts = self.path.strip("/").split("/", 2)
        if len(parts) >= 2 and parts[0] == "raw":
            repo = parts[1]
            if not is_safe_repo(repo):
                self._send_error(400, "bad repo name")
                return
            local = os.path.join(REPO_BASE, repo)
            if not os.path.isdir(os.path.join(local, ".git")):
                self._send_error(404, "repo not found")
                return
            tmp = os.path.join(tempfile.gettempdir(), f"raw-{repo}-{int(time.time())}.tar.gz")
            subprocess.run([
                "tar", "-czf", tmp, "-C", local,
                "--exclude", ".git", "--exclude", "node_modules",
                "--exclude", "venv", "--exclude", ".venv",
                "--exclude", "__pycache__", "--exclude", "dist",
                "--exclude", ".next", "--exclude", "target",
                "--exclude", "*.pyc", "--exclude", ".DS_Store", "."
            ], timeout=30)
            size = os.path.getsize(tmp)
            self.send_response(200)
            self.send_header("Content-Type", "application/gzip")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", 'attachment; filename="'+repo+'.tar.gz"')
            self.end_headers()
            with open(tmp, "rb") as f:
                shutil.copyfileobj(f, self.wfile)
            os.unlink(tmp)
        elif self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self._send_error(404, "not found")

    def do_POST(self):
        parts = self.path.strip("/").split("/", 2)
        if len(parts) >= 2 and parts[0] == "raw-upload":
            repo = parts[1]
            if not is_safe_repo(repo):
                self._send_error(400, "bad repo name")
                return

            content_len = int(self.headers.get("Content-Length", 0))
            if content_len == 0:
                self._send_error(400, "empty body")
                return
            if content_len > MAX_UPLOAD_BYTES:
                self._send_error(413, "request too large (max 50MB)")
                return

            raw_data = self.rfile.read(content_len)
            local = os.path.join(REPO_BASE, repo)
            if not os.path.isdir(local):
                os.makedirs(local, exist_ok=True)

            tmp = os.path.join(tempfile.gettempdir(), f"upload-{repo}-{int(time.time())}.tar.gz")
            with open(tmp, "wb") as f:
                f.write(raw_data)

            # Incremental: never delete existing files — only add/overwrite
            git_dir = os.path.join(local, ".git")
            if not os.path.isdir(git_dir):
                subprocess.run(["git", "init"], cwd=local, timeout=5)

            subprocess.run(["tar", "-xzf", tmp, "-C", local], timeout=15)
            subprocess.run(["git", "add", "-A"], cwd=local, timeout=5)
            os.unlink(tmp)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            import json
            result = json.dumps({
                "ok": True,
                "team": repo,
                "uploadSizeMB": f"{content_len/1048576:.2f}",
                "hint": "Upload successful — file contents updated. Use git_push to commit."
            })
            self.wfile.write(result.encode())
        else:
            self._send_error(404, "not found")

print("Raw server v2.1 on :"+str(PORT))
HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
