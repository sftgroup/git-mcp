import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig } from "./config.js";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const cfg = loadConfig();
  const dbDir = join(cfg.dbPath, "..");
  mkdirSync(dbDir, { recursive: true });
  _db = new Database(cfg.dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  initSchema(_db);
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      github_url TEXT NOT NULL,
      local_path TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'master',
      description TEXT DEFAULT '',
      tags TEXT DEFAULT '',
      guard_config TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER REFERENCES repositories(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      branch TEXT DEFAULT '',
      commit_sha TEXT DEFAULT '',
      message TEXT DEFAULT '',
      triggered_by TEXT DEFAULT '',
      checks_json TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'ok',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      action TEXT NOT NULL DEFAULT 'push',
      commit_sha TEXT NOT NULL,
      message TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      synced_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_repo ON audit_log(repo_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_versions_repo ON versions(repo_id);
    CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_log(status);
  `);
}

// ─── Repo CRUD ────────────────────────────────────────

export interface RepoRow {
  id: number;
  name: string;
  github_url: string;
  local_path: string;
  default_branch: string;
  description: string;
  tags: string;
  guard_config: string;
  created_at: string;
  updated_at: string;
}

export function registerRepo(repo: {
  name: string; github_url: string; local_path: string;
  default_branch?: string; description?: string; tags?: string; guard_config?: string;
}): RepoRow {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO repositories (name, github_url, local_path, default_branch, description, tags, guard_config)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    repo.name, repo.github_url, repo.local_path,
    repo.default_branch ?? "master", repo.description ?? "",
    repo.tags ?? "", repo.guard_config ?? "{}"
  );
  return db.prepare("SELECT * FROM repositories WHERE name = ?").get(repo.name) as RepoRow;
}

export function listRepos(search?: string): RepoRow[] {
  const db = getDb();
  if (search) {
    return db.prepare(
      "SELECT * FROM repositories WHERE name LIKE ? OR description LIKE ? OR tags LIKE ? ORDER BY updated_at DESC"
    ).all(`%${search}%`, `%${search}%`, `%${search}%`) as RepoRow[];
  }
  return db.prepare("SELECT * FROM repositories ORDER BY updated_at DESC").all() as RepoRow[];
}

export function getRepo(name: string): RepoRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM repositories WHERE name = ?").get(name) as RepoRow | undefined;
}

export function updateRepo(name: string, fields: Partial<RepoRow>) {
  const db = getDb();
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (["name", "id"].includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return;
  vals.push(name);
  db.prepare(`UPDATE repositories SET ${sets.join(", ")}, updated_at = datetime('now') WHERE name = ?`).run(...vals);
}

export function deleteRepo(name: string) {
  const db = getDb();
  db.prepare("DELETE FROM repositories WHERE name = ?").run(name);
}

// ─── Versions ──────────────────────────────────────────

export interface VersionRow {
  id: number; repo_id: number; tag: string; commit_sha: string;
  description: string; created_by: string; created_at: string;
}

export function createTag(repoName: string, tag: string, commitSha: string, description?: string, createdBy?: string) {
  const db = getDb();
  const repo = db.prepare("SELECT id FROM repositories WHERE name = ?").get(repoName) as { id: number } | undefined;
  if (!repo) throw new Error(`Repo not found: ${repoName}`);
  db.prepare(
    "INSERT INTO versions (repo_id, tag, commit_sha, description, created_by) VALUES (?, ?, ?, ?, ?)"
  ).run(repo.id, tag, commitSha, description ?? "", createdBy ?? "");
}

export function listTags(repoName: string): VersionRow[] {
  const db = getDb();
  return db.prepare(
    "SELECT v.* FROM versions v JOIN repositories r ON v.repo_id = r.id WHERE r.name = ? ORDER BY v.created_at DESC"
  ).all(repoName) as VersionRow[];
}

export function getLatestTag(repoName: string): VersionRow | undefined {
  const db = getDb();
  return db.prepare(
    "SELECT v.* FROM versions v JOIN repositories r ON v.repo_id = r.id WHERE r.name = ? ORDER BY v.created_at DESC LIMIT 1"
  ).get(repoName) as VersionRow | undefined;
}

// ─── Audit ─────────────────────────────────────────────

export interface AuditRow {
  id: number; repo_id: number; action: string; branch: string;
  commit_sha: string; message: string; triggered_by: string;
  checks_json: string; status: string; created_at: string;
}

export function logAudit(repoName: string, action: string, details: {
  branch?: string; commitSha?: string; message?: string;
  triggeredBy?: string; checks?: any; status?: string;
}) {
  const db = getDb();
  const repo = db.prepare("SELECT id FROM repositories WHERE name = ?").get(repoName) as { id: number } | undefined;
  db.prepare(`
    INSERT INTO audit_log (repo_id, action, branch, commit_sha, message, triggered_by, checks_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    repo?.id ?? 0, action,
    details.branch ?? "", details.commitSha ?? "", details.message ?? "",
    details.triggeredBy ?? "", JSON.stringify(details.checks ?? {}),
    details.status ?? "ok"
  );
}

export function listAudit(repoName?: string, limit = 50): AuditRow[] {
  const db = getDb();
  if (repoName) {
    return db.prepare(
      "SELECT a.* FROM audit_log a JOIN repositories r ON a.repo_id = r.id WHERE r.name = ? ORDER BY a.created_at DESC LIMIT ?"
    ).all(repoName, limit) as AuditRow[];
  }
  return db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?").all(limit) as AuditRow[];
}
