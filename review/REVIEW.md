# Code Quality Review: git-mcp (ceres)

**Reviewed**: 2026-07-13  
**Commit**: `8898c93` — "fix(git-mcp): raw-upload incremental mode — never delete existing files"  
**Project**: ceres-git-mcp (MCP for centralized git workflow + raw file server on 3088)  
**Language**: TypeScript + Python

---

## Summary

| Category | Issues | Severity |
|----------|--------|----------|
| Lint (eslint) | 0 real issues (config missing) | P2 |
| Format (prettier) | 4 files misformatted | P1 |
| Type Check (tsc) | 29 errors | P1 (mainly config) |
| Dependency Audit | 0 vulnerabilities | — |
| Security (raw_server.py) | 2 findings | P1, P2 |
| Code Quality (manual review) | 7 findings | P1, P2 |

**Total: 7 P1 issues, ~5 P2 issues**

---

## 1. Automated Checks

### 1.1 Lint (eslint) — ⚠️ No Config

ESLint found no `.eslintrc` or `eslint.config.js`. The project has no ESLint configuration at all.  
**Recommendation**: Add `.eslintrc.json` or `eslint.config.js` and lint the codebase.  
**Severity**: P2

### 1.2 Format (prettier) — 🔴 4 Files Misformatted

```
[warn] src/db.ts
[warn] src/config.ts
[warn] src/server.ts
[warn] src/tools/gitOps.ts
```

**Fix**: `npx prettier --write src/`  
**Severity**: P1

### 1.3 Type Check (tsc) — 🔴 29 Errors

All 29 type errors fall into two categories:

**A. Missing type roots (20 errors)** — `Cannot find name 'fs'`, `'path'`, `'os'`, `'child_process'`, `'process'`  
**Cause**: `tsconfig.json` has `"types"` set implicitly, but includes only `src/**/*`. The `@types/node` is installed but not being picked up by the include pattern. The `skipLibCheck: true` bypasses this, but strict mode still requires explicit type references.

**B. Implicit `any` (6 errors)** — Express handler parameters `_req`/`res`/`req` missing type annotations.

**C. Module resolution (3 errors)** — `Cannot find module 'better-sqlite3'` and `'express'` — likely because `npm install` hasn't been run on the review server.

**Fix**: 
1. Run `npm install` on the review server
2. Add explicit types: `import type { Request, Response } from 'express'`
3. Consider adding `"types": ["node"]` to `compilerOptions`

**Severity**: P1 (build would fail on fresh install)

### 1.4 Dependency Audit — ✅ Clean

No vulnerable dependencies detected.

---

## 2. `raw_server.py` — Security & Bug Review

### 2.1 ✅ Path Traversal — Protected

**Finding**: The code uses `os.path.join(REPO_BASE, repo)` which prevents path traversal by design. `os.path.join` normalizes any `..` components, so `/raw-upload/../../etc` resolves to `/opt/mcp/repos/etc` safely.  
**Verdict**: No path traversal vulnerability.

### 2.2 ✅ Cleanup Fix Verified

**Previous**: `find -exec rm -rf` (destructive, could wipe existing files)  
**Current**: `tar --keep-old-files` (incremental, never deletes)  
**Verdict**: The fix is correct and properly implemented. The `--keep-old-files` flag prevents tar from overwriting existing files while adding new ones.

### 2.3 🔴 Missing Input Validation — Repo Name Sanitization

**Issue**: `parts[1]` (the repo name) is used directly in `os.path.join()` without validation. Although `os.path.join` prevents path traversal, an attacker could:
- Upload to unexpected directories (e.g., `raw-upload/.git` or empty string)
- Cause filesystem pollution with special characters

```python
repo = parts[1]  # No validation
local = os.path.join(REPO_BASE, repo)
```

**Fix**: Validate repo name against a whitelist or regex (e.g., `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`).

**Severity**: P1

### 2.4 🔴 Content-Length Headers Missing for Errors

**Issue**: Error responses (`send_error(404)`) don't set `Content-Length` or `Content-Type` headers. While not a security vulnerability, it causes undefined behavior in strict HTTP clients.

**Fix**: Call `self.end_headers()` before error, or use `send_header` with proper content info.

**Severity**: P2

### 2.5 🟡 No Request Size Limit

**Issue**: The POST handler reads `Content-Length` without a cap. An attacker could send a massive body (e.g., 100GB claimed) and exhaust server memory.

```python
content_len = int(self.headers.get("Content-Length", 0))
raw_data = self.rfile.read(content_len)  # No cap
```

**Fix**: Add a maximum (e.g., 50MB): `if content_len > 50 * 1024 * 1024: self.send_error(413); return`

**Severity**: P1

### 2.6 🟡 Inefficient GET (Memory Duplication)

**Issue**: The GET handler writes tar to a temp file, reads it entirely into memory, then sends:

```python
subprocess.run(["tar", "-czf", tmp, ...])
with open(tmp, "rb") as f:
    content = f.read()  # Loads entire archive into RAM
os.unlink(tmp)
self.wfile.write(content)
```

For large repos, this doubles memory usage.

**Fix**: Stream the file directly: `with open(tmp, "rb") as f: shutil.copyfileobj(f, self.wfile)`.

**Severity**: P2

### 2.7 ✅ Git Init Before Extraction — Correct

The code initializes git *before* extraction to ensure `.git` exists:

```python
if not os.path.isdir(git_dir):
    subprocess.run(["git", "init"], cwd=local, timeout=5)
subprocess.run(["tar", "-xzf", tmp, "-C", local, "--keep-old-files"], timeout=15)
```

This is correct — `.git` needs to exist before extraction if the tar includes git-tracked files.

---

## 3. TypeScript Code Quality — Manual Review

### 3.1 🔴 `gitOps.ts:327` — Unvalidated `execSync` Input from Config

**Issue**: `apiCreateGithubRepo()` uses `cfg.githubOrg` directly in a URL and shell command without validation:

```typescript
const url = `https://api.github.com/orgs/${org}/repos`;
```

If `githubOrg` contains malicious characters (e.g., from a compromised config), it could lead to unexpected API calls.

**Severity**: P2 (config is trusted, but defense-in-depth matters)

### 3.2 🔴 `gitOps.ts:429` — Recursive `apiCheck` Call Could Loop

**Issue**: In `apiPush()`, `apiCheck()` is called. If `apiCheck` is configured with a check command that triggers another push, infinite recursion is possible (though unlikely).

**Severity**: P3

### 3.3 🟡 `gitOps.ts` — Dynamic `import("../db.js")` in Hot Paths

**Issue**: `apiPush` and `apiSync` use dynamic `import("../db.js")` at runtime. This adds latency on every push/sync call:

```typescript
const db = await import("../db.js");
```

**Fix**: Import `getDb` statically at module top.

**Severity**: P2

### 3.4 🟡 `server.ts:66-78` — Missing Type Annotations

**Issue**: Express route handlers have implicit `any` types:

```typescript
app.get("/", (_req, res) => { ... });  // _req: any, res: any
app.get("/health", (_req, res) => { ... });
```

**Fix**: `import { Request, Response } from 'express'` and annotate parameters.

**Severity**: P2

### 3.5 🟡 `db.ts` — Error Prone `join(cfg.dbPath, "..")` 

**Issue**: 

```typescript
const dbDir = join(cfg.dbPath, "..");
```

Using `".."` to get the parent directory is fragile. If `cfg.dbPath` is already a relative path or doesn't have a parent, this produces unexpected results.

**Fix**: Use `path.dirname(cfg.dbPath)`.

**Severity**: P2

### 3.6 ✅ `gitOps.ts:173` — Properly Handles Dirty Working Tree

The pull check for uncommitted changes is correct:

```typescript
if (dirty.length > 0) {
    return { ok: false, dirty: true, ... };
}
```

**Verdict**: Correct behavior.

### 3.7 ✅ `gitOps.ts:206` — Force Push Disabled

```typescript
if (!input.skipChecks) {
    checkResult = await apiCheck({ name: input.name, branch });
    if (!checkResult.passed) return { ok: false, ... };
}
```

**Verdict**: Correctly prevents destructive pushes. The `skipChecks` flag is available for trusted scenarios.

---

## 4. Architecture Notes

| Aspect | Assessment |
|--------|------------|
| Separation of concerns | ✅ Clear: MCP server (3082) + raw file server (3088) |
| Error handling | ✅ Consistent try/catch with meaningful messages |
| DB schema | ✅ SQLite with WAL, foreign keys, indexes |
| Audit logging | ✅ All mutations are logged |
| Incremental-only policy | ✅ No force push, `--keep-old-files` for uploads |
| Config management | ✅ Falls back to sensible defaults |

---

## 5. Recommendations (Priority Order)

1. **[P1]** Add request size limit to `raw_server.py` POST handler (50MB cap)
2. **[P1]** Validate repo names in `raw_server.py` against a safe regex
3. **[P1]** Run `prettier --write src/` to fix formatting
4. **[P1]** Fix `tsconfig.json` type resolution (add `"types": ["node"]` or fix include paths)
5. **[P2]** Add ESLint configuration
6. **[P2]** Replace `join(cfg.dbPath, "..")` with `path.dirname(cfg.dbPath)`
7. **[P2]** Move dynamic `import("../db.js")` to static imports in `gitOps.ts`
8. **[P2]** Add explicit `Request`/`Response` type annotations in `server.ts`
9. **[P2]** Stream tar.gz instead of loading into memory in `raw_server.py` GET handler
10. **[P3]** Validate `githubOrg` from config before use in URLs

---

## 6. Files Reviewed

| File | Lines | Issues Found |
|------|-------|-------------|
| `raw_server.py` | 86 | 4 findings (1 P1, 3 P2) |
| `src/server.ts` | ~80 | Format + types |
| `src/tools/gitOps.ts` | ~430 | Format + types + dynamic imports |
| `src/config.ts` | ~35 | Format + type errors |
| `src/db.ts` | ~170 | Format + type errors + fragile path |
| `package.json` | 18 | ✅ Clean |
| `tsconfig.json` | 14 | Type resolution config issue |
