import Database from "better-sqlite3";
export declare function getDb(): Database.Database;
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
export declare function registerRepo(repo: {
    name: string;
    github_url: string;
    local_path: string;
    default_branch?: string;
    description?: string;
    tags?: string;
    guard_config?: string;
}): RepoRow;
export declare function listRepos(search?: string): RepoRow[];
export declare function getRepo(name: string): RepoRow | undefined;
export declare function updateRepo(name: string, fields: Partial<RepoRow>): void;
export declare function deleteRepo(name: string): void;
export interface VersionRow {
    id: number;
    repo_id: number;
    tag: string;
    commit_sha: string;
    description: string;
    created_by: string;
    created_at: string;
}
export declare function createTag(repoName: string, tag: string, commitSha: string, description?: string, createdBy?: string): void;
export declare function listTags(repoName: string): VersionRow[];
export declare function getLatestTag(repoName: string): VersionRow | undefined;
export interface AuditRow {
    id: number;
    repo_id: number;
    action: string;
    branch: string;
    commit_sha: string;
    message: string;
    triggered_by: string;
    checks_json: string;
    status: string;
    created_at: string;
}
export declare function logAudit(repoName: string, action: string, details: {
    branch?: string;
    commitSha?: string;
    message?: string;
    triggeredBy?: string;
    checks?: any;
    status?: string;
}): void;
export declare function listAudit(repoName?: string, limit?: number): AuditRow[];
