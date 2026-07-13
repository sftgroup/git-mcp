"""Raw code download/upload - no MCP SSE 64KB limit
v2: incremental upload — never deletes existing files, only adds/overwrites
"""
import os, subprocess, tempfile, time
from http.server import HTTPServer, BaseHTTPRequestHandler

REPO_BASE = os.environ.get("REPO_BASE", "/opt/mcp/repos")
PORT = int(os.environ.get("PORT", "3088"))

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        parts = self.path.strip("/").split("/")
        if len(parts) >= 2 and parts[0] == "raw":
            repo = parts[1]
            local = os.path.join(REPO_BASE, repo)
            if not os.path.isdir(os.path.join(local, ".git")):
                self.send_error(404, "Repo not found")
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
            with open(tmp, "rb") as f:
                content = f.read()
            os.unlink(tmp)
            self.send_response(200)
            self.send_header("Content-Type", "application/gzip")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", 'attachment; filename="'+repo+'.tar.gz"')
            self.end_headers()
            self.wfile.write(content)
        elif self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_error(404)

    def do_POST(self):
        parts = self.path.strip("/").split("/")
        if len(parts) >= 2 and parts[0] == "raw-upload":
            repo = parts[1]
            local = os.path.join(REPO_BASE, repo)
            if not os.path.isdir(local):
                os.makedirs(local, exist_ok=True)

            content_len = int(self.headers.get("Content-Length", 0))
            raw_data = self.rfile.read(content_len)

            tmp = os.path.join(tempfile.gettempdir(), f"upload-{repo}-{int(time.time())}.tar.gz")
            with open(tmp, "wb") as f:
                f.write(raw_data)

            # Incremental: never delete existing files — only add/overwrite
            git_dir = os.path.join(local, ".git")
            if not os.path.isdir(git_dir):
                subprocess.run(["git", "init"], cwd=local, timeout=5)

            subprocess.run(["tar", "-xzf", tmp, "-C", local, "--keep-old-files"], timeout=15)
            subprocess.run(["git", "add", "-A"], cwd=local, timeout=5)
            os.unlink(tmp)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            result = '{"ok":true,"team":"'+repo+'","uploadSizeMB":"'+format(content_len/1048576,".2f")+'","hint":"Incremental upload — old files preserved. Use git_push to commit, then git_sync to push to GitHub"}'
            self.wfile.write(result.encode())
        else:
            self.send_error(404)

print("Raw server v2 on :"+str(PORT))
HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
