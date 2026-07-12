import { readFileSync, existsSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";

export interface Config {
  port: number;
  host: string;
  repoBasePath: string;
  dbPath: string;
  githubOrg: string;
}

let _cfg: Config | null = null;
export function loadConfig(): Config {
  if (_cfg) return _cfg;
  const paths = [
    join(homedir(), ".git-mcp", "config.json"),
    join(process.cwd(), "config.json"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      _cfg = JSON.parse(readFileSync(p, "utf-8")) as Config;
      _cfg.repoBasePath ??= join(homedir(), "repos");
      _cfg.dbPath ??= join(homedir(), ".git-mcp", "data.db");
      _cfg.githubOrg ??= "sftgroup";
      return _cfg;
    }
  }
  _cfg = {
    port: 3082, host: "127.0.0.1",
    repoBasePath: join(homedir(), "repos"),
    dbPath: join(homedir(), ".git-mcp", "data.db"),
    githubOrg: "sftgroup",
  };
  mkdirSync(_cfg.repoBasePath, { recursive: true });
  return _cfg;
}
