import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";
import { loadConfig } from "./config.js";
let _db = null;
export function getDb() {
    if (_db)
        return _db;
    const cfg = loadConfig();
    const dbDir = join(cfg.dbPath, "..");
    mkdirSync(dbDir, { recursive: true });
    _db = new Database(cfg.dbPath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initSchema(_db);
    return _db;
}
function initSchema(db) {
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
export function registerRepo(repo) {
    const db = getDb();
    const stmt = db.prepare(`
    INSERT INTO repositories (name, github_url, local_path, default_branch, description, tags, guard_config)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
    stmt.run(repo.name, repo.github_url, repo.local_path, repo.default_branch ?? "master", repo.description ?? "", repo.tags ?? "", repo.guard_config ?? "{}");
    return db.prepare("SELECT * FROM repositories WHERE name = ?").get(repo.name);
}
export function listRepos(search) {
    const db = getDb();
    if (search) {
        return db.prepare("SELECT * FROM repositories WHERE name LIKE ? OR description LIKE ? OR tags LIKE ? ORDER BY updated_at DESC").all(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    return db.prepare("SELECT * FROM repositories ORDER BY updated_at DESC").all();
}
export function getRepo(name) {
    const db = getDb();
    return db.prepare("SELECT * FROM repositories WHERE name = ?").get(name);
}
export function updateRepo(name, fields) {
    const db = getDb();
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
        if (["name", "id"].includes(k))
            continue;
        sets.push(`${k} = ?`);
        vals.push(v);
    }
    if (sets.length === 0)
        return;
    vals.push(name);
    db.prepare(`UPDATE repositories SET ${sets.join(", ")}, updated_at = datetime('now') WHERE name = ?`).run(...vals);
}
export function deleteRepo(name) {
    const db = getDb();
    db.prepare("DELETE FROM repositories WHERE name = ?").run(name);
}
export function createTag(repoName, tag, commitSha, description, createdBy) {
    const db = getDb();
    const repo = db.prepare("SELECT id FROM repositories WHERE name = ?").get(repoName);
    if (!repo)
        throw new Error(`Repo not found: ${repoName}`);
    db.prepare("INSERT INTO versions (repo_id, tag, commit_sha, description, created_by) VALUES (?, ?, ?, ?, ?)").run(repo.id, tag, commitSha, description ?? "", createdBy ?? "");
}
export function listTags(repoName) {
    const db = getDb();
    return db.prepare("SELECT v.* FROM versions v JOIN repositories r ON v.repo_id = r.id WHERE r.name = ? ORDER BY v.created_at DESC").all(repoName);
}
export function getLatestTag(repoName) {
    const db = getDb();
    return db.prepare("SELECT v.* FROM versions v JOIN repositories r ON v.repo_id = r.id WHERE r.name = ? ORDER BY v.created_at DESC LIMIT 1").get(repoName);
}
export function logAudit(repoName, action, details) {
    const db = getDb();
    const repo = db.prepare("SELECT id FROM repositories WHERE name = ?").get(repoName);
    db.prepare(`
    INSERT INTO audit_log (repo_id, action, branch, commit_sha, message, triggered_by, checks_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repo?.id ?? 0, action, details.branch ?? "", details.commitSha ?? "", details.message ?? "", details.triggeredBy ?? "", JSON.stringify(details.checks ?? {}), details.status ?? "ok");
}
export function listAudit(repoName, limit = 50) {
    const db = getDb();
    if (repoName) {
        return db.prepare("SELECT a.* FROM audit_log a JOIN repositories r ON a.repo_id = r.id WHERE r.name = ? ORDER BY a.created_at DESC LIMIT ?").all(repoName, limit);
    }
    return db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?").all(limit);
}
//# sourceMappingURL=db.js.map