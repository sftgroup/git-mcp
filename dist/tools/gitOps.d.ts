import { RepoRow, VersionRow, AuditRow } from "../db.js";
export declare function apiRegisterRepo(input: {
    name: string;
    github_url: string;
    default_branch?: string;
    description?: string;
    tags?: string;
    guard_config?: string;
}): Promise<{
    repo: RepoRow;
    message: string;
}>;
export declare function apiListRepos(input: {
    search?: string;
}): Promise<{
    repos: RepoRow[];
    total: number;
}>;
export declare function apiGetRepo(input: {
    name: string;
}): Promise<{
    repo: RepoRow;
    cloned: any;
    latestTag: string | null;
    latestTagSha: string | null;
    unsyncedCommits: number;
    tags: VersionRow[];
}>;
export declare function apiCreateGithubRepo(input: {
    name: string;
    description?: string;
    private?: boolean;
}): Promise<{
    repo: RepoRow;
    github_url: any;
}>;
export declare function apiClone(input: {
    name: string;
    branch?: string;
}): Promise<{
    alreadyCloned: boolean;
    path: string;
    branch: string;
    headSha: string;
    message: string;
} | {
    alreadyCloned?: undefined;
    message?: undefined;
    path: string;
    branch: string;
    headSha: string;
}>;
export declare function apiPull(input: {
    name: string;
    branch?: string;
}): Promise<{
    ok: boolean;
    dirty: boolean;
    files: string[];
    message: string;
    branch?: undefined;
    beforeSha?: undefined;
    afterSha?: undefined;
} | {
    dirty?: undefined;
    files?: undefined;
    ok: boolean;
    branch: string;
    beforeSha: string;
    afterSha: string;
    message: string;
}>;
export declare function apiPush(input: {
    name: string;
    message: string;
    branch?: string;
    files?: string[];
    force?: boolean;
    skipChecks?: boolean;
}): Promise<{
    branch?: undefined;
    ok: boolean;
    stage: string;
    error: string;
    checks: Record<string, {
        passed: boolean;
        error?: string;
        detail?: string;
    }>;
    commitSha?: undefined;
    stored?: undefined;
    unsyncedCommits?: undefined;
    hint?: undefined;
} | {
    branch?: undefined;
    stage?: undefined;
    ok: boolean;
    error: string;
    commitSha?: undefined;
    stored?: undefined;
    unsyncedCommits?: undefined;
    checks?: undefined;
    hint?: undefined;
} | {
    stage?: undefined;
    error?: undefined;
    ok: boolean;
    commitSha: string;
    branch: string;
    stored: boolean;
    unsyncedCommits: number;
    checks: Record<string, {
        passed: boolean;
        error?: string;
        detail?: string;
    }> | null;
    hint: string | undefined;
}>;
export declare function apiSync(input: {
    name: string;
    branch?: string;
    tag?: string;
}): Promise<{
    branch?: undefined;
    ok: boolean;
    synced: number;
    message: string;
    commits?: undefined;
    headSha?: undefined;
    tag?: undefined;
} | {
    ok: boolean;
    branch: string;
    synced: number;
    commits: {
        sha: string;
        message: string;
    }[];
    headSha: string;
    tag: {
        tag: string;
    } | null;
    message: string;
}>;
export declare function apiSyncStatus(input: {
    name?: string;
}): Promise<{
    name: string;
    unsynced: number;
    commits: {
        sha: string;
        message: string;
    }[];
    repos?: undefined;
    total?: undefined;
} | {
    commits?: undefined;
    name?: undefined;
    unsynced?: undefined;
    repos: any[];
    total: number;
}>;
export declare function apiStatus(input: {
    name: string;
}): Promise<{
    repo: string;
    branch: string;
    commitSha: string;
    dirty: boolean;
    staged: number;
    unstaged: number;
    untracked: number;
    files: string[];
    unsyncedCommits: number;
}>;
export declare function apiCreateTag(input: {
    name: string;
    tag: string;
    description?: string;
}): Promise<{
    tag: string;
    commitSha: string;
}>;
export declare function apiListTags(input: {
    name: string;
}): Promise<{
    tags: VersionRow[];
    total: number;
}>;
export declare function apiLog(input: {
    name: string;
    limit?: number;
}): Promise<{
    repo: string;
    entries: {
        sha: string;
        message: string;
    }[];
    total: number;
}>;
export declare function apiLogAudit(input: {
    name?: string;
    limit?: number;
}): Promise<{
    entries: AuditRow[];
    total: number;
}>;
export declare function apiCheckout(input: {
    name: string;
    ref: string;
}): Promise<{
    branch?: undefined;
    ok: boolean;
    dirty: boolean;
    message: string;
    ref?: undefined;
} | {
    message?: undefined;
    dirty?: undefined;
    ok: boolean;
    ref: string;
    branch: string;
}>;
export declare function apiCheck(input: {
    name: string;
    branch?: string;
}): Promise<{
    passed: boolean;
    checks: Record<string, {
        passed: boolean;
        error?: string;
        detail?: string;
    }>;
}>;
export declare function apiSyncCode(input: {
    team: string;
    source_host: string;
    source_path: string;
}): Promise<{
    team: string;
    status: string;
    sha: string;
    fileCount: number;
    bytes: number;
    path: any;
    timestamp: string;
}>;
export declare function apiSnapshot(input: {
    team: string;
}): Promise<{
    team: string;
    sha: string;
    source: string;
    path: any;
    timestamp: string;
}>;
export declare function apiRepoPull(input: {
    team: string;
    source_host: string;
    source_path: string;
    message?: string;
    author?: string;
}): Promise<{
    branch?: undefined;
    team: string;
    status: string;
    sha: string;
    message: string;
    timestamp: string;
    fileCount?: undefined;
} | {
    team: string;
    status: string;
    sha: string;
    message: string;
    fileCount: number;
    branch: string;
    timestamp: string;
}>;
export declare function apiCodeUpload(input: {
    team: string;
    data?: string;
    branch?: string;
}): Promise<{
    team: string;
    uploadSizeMB: string;
    filesChanged: any;
    hint: string;
    upload_url?: undefined;
} | {
    uploadSizeMB?: undefined;
    filesChanged?: undefined;
    team: string;
    upload_url: string;
    hint: string;
}>;
export declare function apiCodeExport(input: {
    team: string;
}): Promise<{
    team: string;
    branch: string;
    download_url: string;
    sizeMB: string;
    hint: string;
}>;
