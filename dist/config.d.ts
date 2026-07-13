export interface Config {
    port: number;
    host: string;
    repoBasePath: string;
    dbPath: string;
    githubOrg: string;
}
export declare function loadConfig(): Config;
