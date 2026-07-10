# Git MCP — 代码管理服务

> Skill（工作流规范）+ MCP（增量存储 + GitHub 同步）双层架构

---

## 这是什么

所有 OpenClaw agent 和测试服务器的代码统一管理入口：

- **Skill** — 教 agent 什么时候该 push、pull、sync，怎么写 commit message
- **git-mcp** — 增量存储所有代码变更，需要时再推 GitHub，绝不覆盖

---

## 核心设计

```
agent push 代码 → git-mcp 本地增量存储（永不覆盖） ──→ git_sync → GitHub
测试服务器代码  → repo_sync(rsync) → git-mcp 本地    → 算 SHA → code-review
```

**三个关键点：**
1. **增量不覆盖** — 每次 push 是一个独立的 commit，MCP 本地有完整历史
2. **GitHub 推送是单独操作** — `git_sync` 你决定什么时候推，不会意外覆盖
3. **SHA 溯源** — 代码审查报告标 snapshot_sha，机械审计、人工审核、安全检查看同一版代码

---

## 文件结构

```
skills/git-operations/
└── SKILL.md                        # Skill 主文档

mcp/git-mcp/
├── src/
│   ├── server.ts                   # Express HTTP 服务器
│   ├── config.ts                   # 配置管理
│   ├── db.ts                       # SQLite 数据库（仓库/版本/审计/同步状态）
│   └── tools/
│       └── gitOps.ts               # 全部 18 个工具实现（单文件）
├── package.json
├── tsconfig.json
└── git-mcp.service                 # systemd 配置
```

---

## 工具清单（18 个）

### 仓库管理

| 工具 | 说明 |
|------|------|
| `repo_register` | 注册代码库（名称、GitHub URL、描述） |
| `repo_list` | 搜索/列出所有仓库 |
| `repo_info` | 仓库详情 + 最新版本 + 未同步 commits 数 |
| `git_create_repo` | 在 GitHub 上创建新仓库 + 自动注册 |

### 日常开发

| 场景 | 流程 |
|------|------|
| 改代码并推送 | `git_pull` → `git_status` → `repo_check` → `git_push` → `git_sync` |
| 查看状态 | `git_status`（分支、改动文件、未同步数量） |
| 切换分支 | `git_checkout`（有未提交改动时拒绝） |
| 提交历史 | `git_log` |

### 版本发布

| 工具 | 说明 |
|------|------|
| `git_create_tag` | 创建版本标签（如 v1.2.0） |
| `git_tags` | 列出所有版本标签 |
| `git_sync` | 推送本地 commits 到 GitHub（可选同步打 tag） |

### 审计追踪

| 工具 | 说明 |
|------|------|
| `git_audit` | 谁什么时候 push/pull/clone/checkout 了什么 |
| `git_sync_status` | 哪些仓库有未推送到 GitHub 的 commits |

### 测试服务器代码同步

| 工具 | 说明 |
|------|------|
| `repo_sync` | rsync 从测试服务器拉代码到 MCP（排除 node_modules/.git/venv），返回 SHA |
| `repo_snapshot` | 获取当前代码 SHA，不重新同步（供 code-review 溯源用） |

### 代码质量门禁

| 工具 | 说明 |
|------|------|
| `repo_check` | build + lint + guardFiles + 合约 program_id 验证，push 前强制执行 |

---

## 部署

```bash
cd mcp/git-mcp
pnpm install && pnpm build

# 数据库自动创建在 ~/.git-mcp/data.db
# 仓库代码存储在 ~/repos/ （或配置的 repoBasePath）

# GitHub token（推送需要）
export GIT_TOKEN=ghp_xxxxxxxxxxxx

mkdir -p ~/.git-mcp
cat > ~/.git-mcp/config.json << 'EOF'
{
  "port": 3082, "host": "127.0.0.1",
  "repoBasePath": "/home/ubuntu/repos",
  "dbPath": "/home/ubuntu/.git-mcp/data.db",
  "githubOrg": "sftgroup"
}
EOF

sudo cp git-mcp.service /etc/systemd/system/
sudo systemctl enable --now git-mcp
curl http://127.0.0.1:3080/health
```

**前置要求：** Node.js 22+、pnpm、Git、SSH 密钥（repo_sync 需要免密登录测试服务器）

---

## Skill 安装

```bash
openclaw skills install git:sftgroup/agent@master#skills/git-operations --as git-operations
```

---

## 数据库

SQLite 单文件，3 张表：

| 表 | 字段 |
|----|------|
| `repositories` | name, github_url, local_path, default_branch, guard_config |
| `versions` | repo_id, tag, commit_sha, created_at |
| `audit_log` | repo_id, action, branch, commit_sha, message, status |
| `sync_log` | repo_id, commit_sha, status(pending/synced), synced_at |

---

## 与 code-review-mcp 协作

```
1. repo_sync("team3", "43.156.50.6", "/path") → sha: abc123
2. code-review-mcp review_all("/opt/mcp/repos/team3", "all")
3. 报告标注 snapshot_sha: abc123
```
