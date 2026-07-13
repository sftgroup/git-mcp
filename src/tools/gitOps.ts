import { execSync, execFileSync } from "child_process";
import { tmpdir } from "os";
import { statSync, unlinkSync } from "fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../config.js";
import {
  registerRepo, listRepos, getRepo, updateRepo,
  createTag, listTags, getLatestTag,
  logAudit, listAudit,
  RepoRow, VersionRow, AuditRow
} from "../db.js";

const cfg = loadConfig();

// ─── Git helpers ──────────────────────────────────────

function gitTokenUrl(url: string): string {
  const token = process.env.GIT_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
  if (!token) return url;
  return url.replace("https://", `https://${token}@`);
}

function git(cwd: string, cmd: string, timeoutSec = 60): string {
  return execSync(`git ${cmd}`, { cwd, timeout: timeoutSec * 1000, maxBuffer: 5 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
}

function gitOptional(cwd: string, cmd: string, timeoutSec = 30): string {
  try { return git(cwd, cmd, timeoutSec); } catch { return ""; }
}

// ─── Repo Management ──────────────────────────────────

export async function apiRegisterRepo(input: {
  name: string; github_url: string; default_branch?: string;
  description?: string; tags?: string; guard_config?: string;
}) {
  if (getRepo(input.name)) throw new Error(`Repo "${input.name}" already registered`);
  const localPath = join(cfg.repoBasePath, input.name);
  const repo = registerRepo({ ...input, local_path: localPath });
  logAudit(input.name, "repo_register", { triggeredBy: "api", status: "ok" });
  return { repo, message: `Registered ${input.name}. Use git_clone to clone.` };
}

export async function apiListRepos(input: { search?: string }) {
  const repos = listRepos(input.search);
  return { repos, total: repos.length };
}

export async function apiGetRepo(input: { name: string }) {
  const repo = getRepo(input.name);
  if (!repo) throw new Error(`Repo "${input.name}" not found. Use repo_list to see available repos.`);
  const localExists = existsSync(join(repo.local_path, ".git"));
  const latest = getLatestTag(input.name);
  const tags = listTags(input.name);

  // Check sync status (auto-detect branch, skip if no remote refs)
  let unsyncedCommits = 0;
  if (localExists) {
    try {
      const branch = gitOptional(repo.local_path, "rev-parse --abbrev-ref HEAD") || repo.default_branch;
      const ref = gitOptional(repo.local_path, `rev-parse --verify origin/${branch} 2>/dev/null`);
      if (ref) {
        unsyncedCommits = parseInt(gitOptional(repo.local_path, `rev-list --count origin/${branch}..HEAD`) || "0");
      }
    } catch { unsyncedCommits = -1; }
  }

  return {
    repo,
    cloned: localExists,
    latestTag: latest?.tag ?? null,
    latestTagSha: latest?.commit_sha ?? null,
    unsyncedCommits,
    tags,
  };
}

export async function apiCreateGithubRepo(input: { name: string; description?: string; private?: boolean }) {
  const org = cfg.githubOrg;
  const token = process.env.GIT_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GIT_TOKEN env var not set");

  const body = JSON.stringify({
    name: input.name,
    description: input.description ?? "",
    private: input.private ?? false,
    auto_init: true,
  });
  const url = `https://api.github.com/orgs/${org}/repos`;
  const result = execSync(
    `curl -s -X POST "${url}" -H "Authorization: token ${token}" -H "Content-Type: application/json" -d '${body}'`,
    { timeout: 30000 }
  ).toString();
  const ghRepo = JSON.parse(result);
  if (ghRepo.message && ghRepo.message !== "Created") {
    throw new Error(`GitHub API error: ${ghRepo.message}`);
  }

  const githubUrl = ghRepo.ssh_url ?? `https://github.com/${org}/${input.name}.git`;
  const localPath = join(cfg.repoBasePath, input.name);
  const repo = registerRepo({
    name: input.name,
    github_url: githubUrl,
    local_path: localPath,
    default_branch: ghRepo.default_branch ?? "master",
    description: input.description,
  });
  logAudit(input.name, "github_create", { triggeredBy: "api", status: "ok" });
  return { repo, github_url: ghRepo.html_url };
}

// ─── Clone (GitHub → MCP local) ───────────────────────

export async function apiClone(input: { name: string; branch?: string }) {
  const repo = getRepo(input.name);
  if (!repo) throw new Error(`Repo "${input.name}" not found`);
  const localPath = repo.local_path;
  const branch = input.branch ?? repo.default_branch;

  if (existsSync(join(localPath, ".git"))) {
    // Already cloned — pull from GitHub to sync
    git(localPath, `checkout ${branch}`);
    const out = git(localPath, "pull --rebase origin " + (branch || repo.default_branch));
    const sha = gitOptional(localPath, "rev-parse HEAD");
    logAudit(input.name, "clone", { branch, commitSha: sha, status: "ok", message: "already cloned, pulled" });
    return { alreadyCloned: true, path: localPath, branch, headSha: sha, message: out };
  }

  mkdirSync(localPath, { recursive: true });
  const url = gitTokenUrl(repo.github_url);
  git(localPath, `clone -b "${branch}" --single-branch "${url}" .`);
  const sha = gitOptional(localPath, "rev-parse HEAD");
  logAudit(input.name, "clone", { branch, commitSha: sha, status: "ok" });
  return { path: localPath, branch, headSha: sha };
}

// ─── Pull (GitHub → MCP local) ────────────────────────

export async function apiPull(input: { name: string; branch?: string }) {
  const repo = getRepo(input.name);
  if (!repo) throw new Error(`Repo "${input.name}" not found`);
  if (!existsSync(join(repo.local_path, ".git"))) throw new Error(`Not cloned. Run git_clone first.`);

  const branch = input.branch ?? repo.default_branch;

  // Check for uncommitted changes
  const status = git(repo.local_path, "status --porcelain");
  const dirty = status.split("\n").filter(Boolean);

  if (dirty.length > 0) {
    return {
      ok: false, dirty: true,
      files: dirty.map(l => l.substring(3)).slice(0, 20),
      message: `${dirty.length} uncommitted file(s). Commit or stash before pull.`
    };
  }

  // Ensure remote exists (may have been lost)
  const url = gitTokenUrl(repo.github_url);
  const rem = gitOptional(repo.local_path, "remote get-url origin");
  if (!rem) {
    git(repo.local_path, `remote add origin "${url}"`);
  }
  
  git(repo.local_path, `checkout ${branch}`);
  const before = git(repo.local_path, "rev-parse HEAD");
  const out = git(repo.local_path, "pull --rebase origin " + (branch || repo.default_branch));
  const after = git(repo.local_path, "rev-parse HEAD");

  logAudit(input.name, "pull", { branch, commitSha: after, message: out, status: "ok" });
  return { ok: true, branch, beforeSha: before, afterSha: after, message: out };
}

// ─── Push (agent → MCP local, INCREMENTAL) ────────────

export async function apiPush(input: {
  name: string; message: string; branch?: string;
  files?: string[]; force?: boolean; skipChecks?: boolean;
}) {
  const repo = getRepo(input.name);
  if (!repo) throw new Error(`Repo "${input.name}" not found`);
  const localPath = repo.local_path;
  const branch = input.branch ?? repo.default_branch;

  if (!existsSync(join(localPath, ".git"))) throw new Error(`Not cloned. Run git_clone first.`);

  // 1. Integrity check (unless skipped)
  let checkResult = null;
  if (!input.skipChecks) {
    checkResult = await apiCheck({ name: input.name, branch });
    if (!checkResult.passed) {
      return {
        ok: false, stage: "integrity_check",
        error: "Integrity check failed. Fix errors before pushing. Force-push is disabled to protect code integrity. Only incremental updates are allowed.",
        checks: checkResult.checks,
      };
    }
  }

  // 2. Stage files
  git(localPath, "add .");
  if (input.files) {
    git(localPath, "reset HEAD");
    for (const f of input.files) git(localPath, `add "${f}"`);
  }

  // 3. Check if anything to commit
  const status = gitOptional(localPath, "status --porcelain");
  if (!status) return { ok: false, error: "No changes to commit." };

  // 4. Commit — MCP local only (incremental, never overwrites)
  git(localPath, `commit -m "${input.message.replace(/"/g, '\\"')}"`);

  const commitSha = git(localPath, "rev-parse HEAD");

  // 5. Check unsynced count (auto-detect branch, verify remote ref exists first)
  let unsyncedCount = 0;
  try {
    const actualBranch = gitOptional(localPath, "rev-parse --abbrev-ref HEAD") || branch;
    const ref = gitOptional(localPath, `rev-parse --verify origin/${actualBranch} 2>/dev/null`);
    if (ref) {
      unsyncedCount = parseInt(gitOptional(localPath, `rev-list --count origin/${actualBranch}..HEAD`) || "0");
    }
  } catch { unsyncedCount = -1; }

  logAudit(input.name, "push", {
    branch, commitSha,
    message: input.message,
    checks: checkResult?.checks ?? {},
    status: "ok",
  });

  // Record sync state in DB
  const db = await import("../db.js");
  db.getDb().prepare(
    "INSERT INTO sync_log (repo_id, action, commit_sha, message, status) VALUES (?, 'push', ?, ?, 'pending')"
  ).run(
    (db.getRepo(input.name) as any)?.id ?? 0,
    commitSha,
    input.message
  );

  return {
    ok: true, commitSha, branch, stored: true,
    unsyncedCommits: unsyncedCount,
    checks: checkResult?.checks ?? null,
    hint: unsyncedCount > 0
      ? `WARNING: ${unsyncedCount} local commit(s) not synced to GitHub. Run git_sync when ready.`
      : undefined,
  };
}

// ─── Sync (MCP local → GitHub) ────────────────────────

export async function apiSync(input: { name: string; branch?: string; tag?: string }) {
  const repo = getRepo(input.name);
  if (!repo) throw new Error(`Repo "${input.name}" not found`);
  if (!existsSync(join(repo.local_path, ".git"))) throw new Error(`Not cloned.`);

  const token = process.env.GIT_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GIT_TOKEN not set — cannot sync to GitHub");

  const branch = input.branch ?? repo.default_branch;
  git(repo.local_path, `checkout ${branch}`);

  // Count what we're about to push
  const unsyncedCount = parseInt(gitOptional(repo.local_path, `rev-list --count origin/${branch}..HEAD`) || "0");
  if (unsyncedCount === 0) {
    return { ok: true, synced: 0, message: "Already in sync — nothing to push." };
  }

  // Show what will be pushed
  const logSummary = git(repo.local_path, `log --oneline origin/${branch}..HEAD`);
  const syncCommits = logSummary.split("\n").filter(Boolean).map(line => {
    const [sha, ...msg] = line.split(" ");
    return { sha, message: msg.join(" ") };
  });

  // Push to GitHub
  const pushOut = git(repo.local_path, `push origin ${branch}`);

  // Create tag if requested
  let tagResult = null;
  if (input.tag) {
    git(repo.local_path, `tag -a "${input.tag}" -m "${input.tag}"`);
    git(repo.local_path, `push origin "${input.tag}"`);
    createTag(input.name, input.tag, syncCommits[syncCommits.length - 1]?.sha ?? "", input.tag, "api");
    tagResult = { tag: input.tag };
  }

  // Update sync_log
  const db = await import("../db.js");
  const repoId = (db.getRepo(input.name) as any)?.id ?? 0;
  for (const c of syncCommits) {
    db.getDb().prepare(
      "UPDATE sync_log SET status = 'synced', synced_at = datetime('now') WHERE commit_sha = ? AND status = 'pending'"
    ).run(c.sha);
  }

  const headSha = git(repo.local_path, "rev-parse HEAD");
  logAudit(input.name, "sync", { branch, commitSha: headSha, message: `Synced ${unsyncedCount} commits`, status: "ok" });

  return {
    ok: true, branch,
    synced: syncCommits.length,
    commits: syncCommits,
    headSha,
    tag: tagResult,
    message: pushOut,
  };
}

export async function apiSyncStatus(input: { name?: string }) {
  if (input.name) {
    const repo = getRepo(input.name);
    if (!repo) throw new Error(`Repo "${input.name}" not found`);
    if (!existsSync(join(repo.local_path, ".git"))) return { name: input.name, unsynced: 0, commits: [] };

    const branch = repo.default_branch;
    // Skip fetch for speed — verify ref exists before counting
    const ref = gitOptional(repo.local_path, `rev-parse --verify origin/${branch} 2>/dev/null`);
    const count = ref ? parseInt(gitOptional(repo.local_path, `rev-list --count origin/${branch}..HEAD`) || "0") : 0;

    let commits: { sha: string; message: string }[] = [];
    if (count > 0) {
      const log = git(repo.local_path, `log --oneline origin/${branch}..HEAD`);
      commits = log.split("\n").filter(Boolean).map(line => {
        const [sha, ...msg] = line.split(" ");
        return { sha, message: msg.join(" ") };
      });
    }

    return { name: input.name, unsynced: count, commits };
  }

  // All repos
  const repos = listRepos();
  const results: any[] = [];
  for (const repo of repos) {
    if (!existsSync(join(repo.local_path, ".git"))) continue;
    try {
      // Skip fetch for speed — verify ref exists before counting
      const ref = gitOptional(repo.local_path, `rev-parse --verify origin/${repo.default_branch} 2>/dev/null`);
      const count = ref ? parseInt(gitOptional(repo.local_path, `rev-list --count origin/${repo.default_branch}..HEAD`) || "0") : 0;
      if (count > 0) {
        const log = git(repo.local_path, `log --oneline origin/${repo.default_branch}..HEAD`);
        const commits = log.split("\n").filter(Boolean).map(line => {
          const [sha, ...msg] = line.split(" ");
          return { sha, message: msg.join(" ") };
        });
        results.push({ name: repo.name, unsynced: count, commits });
      } else {
        results.push({ name: repo.name, unsynced: 0, commits: [] });
      }
    } catch {
      results.push({ name: repo.name, unsynced: -1, error: "fetch failed" });
    }
  }

  return { repos: results, total: results.length };
}

// ─── Status ────────────────────────────────────────────

export async function apiStatus(input: { name: string }) {
  const repo = getRepo(input.name);
  if (!repo) throw new Error(`Repo "${input.name}" not found`);
  if (!existsSync(join(repo.local_path, ".git"))) throw new Error(`Not cloned.`);

  const branch = git(repo.local_path, "branch --show-current");
  const status = git(repo.local_path, "status --porcelain");
  const commitSha = gitOptional(repo.local_path, "rev-parse HEAD");

  const staged = status.split("\n").filter(l => /^[MADRC]/.test(l));
  const unstaged = status.split("\n").filter(l => /^.[MDRC]/.test(l));
  const untracked = status.split("\n").filter(l => /^\?\?/.test(l));

  // Unsynced check — verify ref exists before counting
  let unsyncedCommits = 0;
  try {
    const ref = gitOptional(repo.local_path, `rev-parse --verify origin/${branch} 2>/dev/null`);
    if (ref) {
      unsyncedCommits = parseInt(gitOptional(repo.local_path, `rev-list --count origin/${branch}..HEAD`) || "0");
    }
  } catch { unsyncedCommits = -1; }

  return {
    repo: input.name, branch, commitSha,
    dirty: status.length > 0,
    staged: staged.length, unstaged: unstaged.length, untracked: untracked.length,
    files: status.split("\n").filter(Boolean).map(l => l.substring(3)).slice(0, 50),
    unsyncedCommits,
  };
}

// ─── Tags ──────────────────────────────────────────────

export async function apiCreateTag(input: { name: string; tag: string; description?: string }) {
  const repo = getRepo(input.name);
  if (!repo) throw new Error(`Repo "${input.name}" not found`);
  if (!existsSync(join(repo.local_path, ".git"))) throw new Error(`Not cloned.`);

  const commitSha = git(repo.local_path, "rev-parse HEAD");
  git(repo.local_path, `tag -a "${input.tag}" -m "${input.description ?? input.tag}"`);
  git(repo.local_path, `push origin "${input.tag}"`);

  createTag(input.name, input.tag, commitSha, input.description, "api");
  logAudit(input.name, "tag", { branch: input.tag, commitSha, message: `Created tag ${input.tag}`, status: "ok" });
  return { tag: input.tag, commitSha };
}

export async function apiListTags(input: { name: string }) {
  const tags = listTags(input.name);
  return { tags, total: tags.length };
}

// ─── Log ───────────────────────────────────────────────

export async function apiLog(input: { name: string; limit?: number }) {
  const repo = getRepo(input.name);
  if (!repo) throw new Error(`Repo "${input.name}" not found`);
  if (!existsSync(join(repo.local_path, ".git"))) throw new Error(`Not cloned.`);

  const n = input.limit ?? 20;
  const raw = git(repo.local_path, `log --oneline -${n}`);
  const entries = raw.split("\n").filter(Boolean).map(line => {
    const [sha, ...msg] = line.split(" ");
    return { sha, message: msg.join(" ") };
  });

  return { repo: input.name, entries, total: entries.length };
}

export async function apiLogAudit(input: { name?: string; limit?: number }) {
  const rows = listAudit(input.name, input.limit ?? 50);
  return { entries: rows, total: rows.length };
}

// ─── Checkout ──────────────────────────────────────────

export async function apiCheckout(input: { name: string; ref: string }) {
  const repo = getRepo(input.name);
  if (!repo) throw new Error(`Repo "${input.name}" not found`);
  if (!existsSync(join(repo.local_path, ".git"))) throw new Error(`Not cloned.`);

  const status = gitOptional(repo.local_path, "status --porcelain");
  if (status) return { ok: false, dirty: true, message: "Uncommitted changes. Commit or stash first." };

  const out = git(repo.local_path, `checkout "${input.ref}"`);
  const branch = git(repo.local_path, "branch --show-current");
  logAudit(input.name, "checkout", { branch, commitSha: gitOptional(repo.local_path, "rev-parse HEAD"), message: out });
  return { ok: true, ref: input.ref, branch };
}

// ─── Integrity Check ──────────────────────────────────

export async function apiCheck(input: { name: string; branch?: string }) {
  const repo = getRepo(input.name);
  if (!repo) throw new Error(`Repo "${input.name}" not found`);
  const localPath = repo.local_path;
  if (!existsSync(join(localPath, ".git"))) throw new Error(`Not cloned.`);

  const guardConfig = JSON.parse(repo.guard_config ?? "{}") as {
    checks?: { checkCmd?: string; lintCmd?: string; testCmd?: string; requireAllPass?: boolean; };
    guardFiles?: Record<string, string>;
    contracts?: { type: string; programId?: string; };
  };

  const results: Record<string, { passed: boolean; error?: string; detail?: string }> = {};
  let allPassed = true;

  if (guardConfig.checks?.checkCmd) {
    try {
      execSync(guardConfig.checks.checkCmd, { cwd: localPath, timeout: 180_000, maxBuffer: 5 * 1024 * 1024 });
      results.check = { passed: true };
    } catch (e: any) {
      results.check = { passed: false, error: e.stderr?.toString().substring(0, 500) ?? e.message };
      allPassed = false;
    }
  }

  if (guardConfig.checks?.lintCmd) {
    try {
      execSync(guardConfig.checks.lintCmd, { cwd: localPath, timeout: 120_000, maxBuffer: 5 * 1024 * 1024 });
      results.lint = { passed: true };
    } catch (e: any) {
      results.lint = { passed: false, error: e.stderr?.toString().substring(0, 500) ?? e.message };
      allPassed = false;
    }
  }

  if (guardConfig.checks?.testCmd) {
    try {
      execSync(guardConfig.checks.testCmd, { cwd: localPath, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
      results.test = { passed: true };
    } catch (e: any) {
      results.test = { passed: false, error: e.stderr?.toString().substring(0, 500) ?? e.message };
      allPassed = false;
    }
  }

  if (guardConfig.guardFiles && Object.keys(guardConfig.guardFiles).length > 0) {
    const guardIssues: string[] = [];
    const diffOut = gitOptional(localPath, "diff --name-only HEAD~1..HEAD");
    const changedFiles = diffOut.split("\n").filter(Boolean);

    for (const [pattern, label] of Object.entries(guardConfig.guardFiles)) {
      const matches = changedFiles.filter(f => {
        if (pattern.includes("*")) {
          const re = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
          return re.test(f);
        }
        return f === pattern;
      });

      if (matches.length > 0) {
        guardIssues.push(`Guard file changed: ${matches.join(", ")} [${label}] — verify intentional`);
      }
    }

    results.guardFiles = {
      passed: guardIssues.length === 0,
      detail: guardIssues.length > 0 ? guardIssues.join("; ") : "No guard files changed",
    };
    if (guardIssues.length > 0) allPassed = false;
  }

  if (guardConfig.contracts?.type === "solana" && guardConfig.contracts.programId) {
    const programIdPattern = guardConfig.contracts.programId;
    const declFiles = gitOptional(localPath, "grep -l declare_id || true").split("\n").filter(Boolean);
    let programIdOk = true;
    for (const f of declFiles) {
      const content = readFileSync(join(localPath, f), "utf-8");
      if (!content.includes(programIdPattern)) {
        programIdOk = false;
        results.contracts = { passed: false, error: `program_id changed or missing in ${f}` };
      }
    }
    if (programIdOk) {
      results.contracts = { passed: true, detail: `Program ID ${programIdPattern} verified` };
    } else {
      allPassed = false;
    }
  }

  return { passed: allPassed, checks: results };
}

// ─── Code Sync (test server → MCP local) ─────────────
// Agent-initiated, NOT automatic. Uses rsync over SSH.
// Excludes: node_modules, .git, venv, __pycache__, dist, build, .next, target

const RSYNC_EXCLUDES = [
  "node_modules/", ".git/", "venv/", ".venv/", "__pycache__/",
  "dist/", "build/", ".next/", "target/", "*.pyc", ".DS_Store"
];

export async function apiSyncCode(input: {
  team: string; source_host: string; source_path: string;
}) {
  const team = input.team;
  const destPath = join(cfg.repoBasePath, team);

  // Ensure destination exists
  mkdirSync(destPath, { recursive: true });

  // Build rsync command
  const excludes = RSYNC_EXCLUDES.map(e => `--exclude='${e}'`).join(" ");
  const cmd = `rsync -az --delete ${excludes} ${input.source_host}:${input.source_path}/ ${destPath}/`;

  let stdout: string;
  try {
    stdout = execSync(cmd, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }).toString().trim();
  } catch (e: any) {
    throw new Error(`rsync failed: ${e.stderr?.toString() ?? e.message}`.substring(0, 500));
  }

  // Count files synced
  const fileCount = parseInt(
    execSync(`find ${destPath} -type f | wc -l`, { timeout: 5000 }).toString().trim()
  ) || 0;

  const totalBytes = parseInt(
    execSync(`du -sb ${destPath} | cut -f1`, { timeout: 5000 }).toString().trim()
  ) || 0;

  // Compute snapshot SHA
  let sha: string;
  if (existsSync(join(destPath, ".git"))) {
    sha = gitOptional(destPath, "rev-parse HEAD");
  } else {
    // No git — hash the file tree
    sha = execSync(
      `find ${destPath} -type f -exec sha256sum {} \\; | sort -k2 | sha256sum | cut -d' ' -f1`,
      { timeout: 30000 }
    ).toString().trim();
  }

  logAudit(team, "repo_sync", {
    branch: input.source_host,
    commitSha: sha,
    message: `Synced from ${input.source_host}:${input.source_path}, ${fileCount} files, ${(totalBytes/1024/1024).toFixed(1)}MB`,
    status: "ok",
  });

  return {
    team,
    status: "synced",
    sha,
    fileCount,
    bytes: totalBytes,
    path: destPath,
    timestamp: new Date().toISOString(),
  };
}

// ─── Snapshot (get SHA without re-syncing) ────────────

export async function apiSnapshot(input: { team: string }) {
  const destPath = join(cfg.repoBasePath, input.team);

  if (!existsSync(destPath)) {
    throw new Error(`Team "${input.team}" not synced. Run repo_sync first.`);
  }

  let sha: string;
  let source = "unknown";

  if (existsSync(join(destPath, ".git"))) {
    sha = git(destPath, "rev-parse HEAD");

    // Try to get last commit info
    const lastCommit = gitOptional(destPath, "log -1 --format='%H %s %ai'");
    if (lastCommit) {
      const parts = lastCommit.split(" ");
      source = "git";
    }
  } else {
    sha = execSync(
      `find ${destPath} -type f -exec sha256sum {} \\; | sort -k2 | sha256sum | cut -d' ' -f1`,
      { timeout: 30000 }
    ).toString().trim();
    source = "file-tree";
  }

  return {
    team: input.team,
    sha,
    source,
    path: destPath,
    timestamp: new Date().toISOString(),
  };
}

// ─── Pull from Test Server (rsync back + git commit + git push) ──
// rsync from test server, automatically commit to MCP local, then sync to GitHub
// This is the REVERSE direction: test server → MCP → GitHub

export async function apiRepoPull(input: {
  team: string;
  source_host: string;
  source_path: string;
  message?: string;
  author?: string;
}) {
  const team = input.team;
  const destPath = join(cfg.repoBasePath, team);
  const author = input.author || "git-mcp";
  const message = input.message || `sync: pull from test server ${input.source_host}:${input.source_path}`;

  // 1. Ensure repo exists
  if (!existsSync(destPath)) {
    throw new Error(`Repo not found: ${team}. Use repo_register first.`);
  }

  // 2. Rsync from test server (code → MCP local)
  const excludes = RSYNC_EXCLUDES.map(e => `--exclude='${e}'`).join(" ");
  const cmd = `rsync -az --delete ${excludes} ${input.source_host}:${input.source_path}/ ${destPath}/`;

  let stdout: string;
  try {
    stdout = execSync(cmd, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }).toString().trim();
  } catch (e: any) {
    throw new Error(`rsync failed: ${e.stderr?.toString() ?? e.message}`.substring(0, 500));
  }

  // 3. Git add + commit (incremental)
  try {
    git(destPath, "add -A");
    // Check if there are changes
    const diffStat = gitOptional(destPath, "diff --cached --stat");
    if (!diffStat) {
      // No changes — still compute SHA
      const sha = git(destPath, "rev-parse HEAD").trim();
      return {
        team,
        status: "no_changes",
        sha,
        message: "No changes to commit after rsync.",
        timestamp: new Date().toISOString(),
      };
    }

    // Commit
    // Write commit message to temp file to avoid shell escaping issues
    const tmpMsg = join(tmpdir(), `commit-msg-${Date.now()}.txt`);
    writeFileSync(tmpMsg, message);
    git(destPath, `commit -F "${tmpMsg}" --author="${author} <${author}@git-mcp.local>"`);
    try { unlinkSync(tmpMsg); } catch {}

    const sha = git(destPath, "rev-parse HEAD").trim();

    // 4. Push to GitHub
    const token = process.env.GIT_TOKEN;
    if (!token) {
      return {
        team,
        status: "committed_local_only",
        sha,
        message: "Committed to MCP local but GIT_TOKEN not set — skip GitHub push.",
        timestamp: new Date().toISOString(),
      };
    }

    const branch = git(destPath, "rev-parse --abbrev-ref HEAD").trim();
    
    const repo = getRepo(team); if (!repo) throw new Error("Repo not found: " + team); const ghUrl = repo.github_url;
    const pushUrl = ghUrl.replace("https://", `https://${token}@`).replace(/\.git$/, "");
    git(destPath, `push ${pushUrl} ${branch}`);

    logAudit(team, "repo_pull", {
      branch,
      commitSha: sha,
      message,

      status: "ok",
    });

    // Count files
    const fileCount = parseInt(
      execSync(`find ${destPath} -type f | wc -l`, { timeout: 5000 }).toString().trim()
    ) || 0;

    return {
      team,
      status: "pulled",
      sha,
      message,
      fileCount,
      branch,
      timestamp: new Date().toISOString(),
    };
  } catch (e: any) {
    throw new Error(`Git operation failed: ${e.stderr?.toString() ?? e.message}`.substring(0, 500));
  }
}

// ─── Code Export (MCP local → agent via HTTP) ───


// ─── Code Upload (agent/test-server → MCP via HTTP) ───
// Receives base64 tar.gz, extracts to /opt/mcp/repos/<team>
export async function apiCodeUpload(input: { team: string, data?: string, branch?: string }) {
  const localPath = join(cfg.repoBasePath, input.team);
  
  // Also support inline base64 for small uploads
  if (input.data) {
    if (!existsSync(localPath)) {
      mkdirSync(localPath, { recursive: true });
    }
    const inFile = join(tmpdir(), `upload-${input.team}-${Date.now()}.tar.gz`);
    try {
      writeFileSync(inFile, Buffer.from(input.data, "base64"));
      // Incremental extraction: never delete existing files, only add/overwrite
      if (!existsSync(join(localPath, ".git"))) {
        execSync(`git init`, { cwd: localPath, timeout: 5000 });
      }
      execFileSync("tar", ["-xzf", inFile, "-C", localPath, "--keep-old-files"], { timeout: 15000 });
      execSync("git add -A", { cwd: localPath, timeout: 5000 });
      const stat = statSync(inFile);
      const files = execSync("git diff --cached --stat", { cwd: localPath, encoding: "utf8", timeout: 5000 });
      // Note: old files NOT in the tarball are preserved — use git rm to explicitly delete
      return {
        team: input.team,
        uploadSizeMB: (stat.size / 1048576).toFixed(2),
        filesChanged: files.trim() || "no changes",
        hint: "Incremental upload — old files preserved. Use git_push to commit, then git_sync to push to GitHub."
      };
    } finally {
      try { unlinkSync(inFile); } catch {}
    }
  }

  // No data provided → return upload URL for large files
  return {
    team: input.team,
    upload_url: `http://43.156.46.187:3088/raw-upload/${input.team}`,
    hint: "Use exec curl to upload the tar.gz directly (no 64KB limit). Example: curl --data-binary @project.tar.gz <upload_url>"
  };
}

export async function apiCodeExport(input: { team: string }) {
  const localPath = join(cfg.repoBasePath, input.team);
  if (!existsSync(localPath)) {
    throw new Error(`Repo "${input.team}" not found. Use repo_list.`);
  }
  if (!existsSync(join(localPath, ".git"))) {
    throw new Error(`Repo "${input.team}" not cloned. Use git_clone first.`);
  }

  const repo = await import("../db.js").then(m => m.getRepo(input.team));
  const branch = repo?.default_branch ?? "main";
  
  // Get size without building archive (just for info)
  const du = execSync("du -sb --exclude .git --exclude node_modules --exclude venv " + localPath, { encoding: "utf8", timeout: 5000 }).trim();
  const sizeBytes = parseInt(du.split(/\s/)[0] || "0");

  return {
    team: input.team,
    branch,
    download_url: `http://43.156.46.187:3088/raw/${input.team}`,
    sizeMB: (sizeBytes / 1048576).toFixed(2),
    hint: "Use exec curl or wget to download the full tar.gz. Example: curl -o repo.tar.gz <download_url> && tar xzf repo.tar.gz"
  };
}
