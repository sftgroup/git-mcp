#!/bin/bash
# git-mcp self-healing: ensure all repos have valid origin refs
# Run before git-mcp starts (ExecStartPre)
set -e
if [ -z "$TOKEN" ]; then
  echo "[self-heal] GIT_TOKEN not set, skipping remote repairs"
  exit 0
fi

REPOS_DIR="/opt/mcp/repos"
DB_PATH="$HOME/.git-mcp/data.db"
TOKEN="${GIT_TOKEN:-}"

for repo_dir in "$REPOS_DIR"/*/; do
  repo_name=$(basename "$repo_dir")
  cd "$repo_dir" 2>/dev/null || continue
  [ -d .git ] || continue

  # Check if origin remote exists
  remote=$(git remote get-url origin 2>/dev/null || echo "")
  if [ -z "$remote" ]; then
    # Try to get GitHub URL from DB
    gh_url=$(sqlite3 "$DB_PATH" "SELECT github_url FROM repositories WHERE name='$repo_name';" 2>/dev/null)
    if [ -n "$gh_url" ]; then
      echo "[self-heal] $repo_name: adding origin $gh_url"
      git remote add origin "$gh_url" 2>/dev/null || true
    fi
  fi

  # Update remote URL to use token
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "https://x-access-token:${TOKEN}@github.com/sftgroup/${repo_name}.git" 2>/dev/null || true
  fi

  # Fetch to get origin refs (quietly)
  git fetch origin --quiet 2>/dev/null || continue

  # Detect default branch from origin
  default_b=$(git remote show origin 2>/dev/null | grep "HEAD branch" | awk '{print $NF}' )
  if [ -z "$default_b" ]; then
    # fallback: try main then master
    if git rev-parse --verify origin/main >/dev/null 2>&1; then default_b="main"
    elif git rev-parse --verify origin/master >/dev/null 2>&1; then default_b="master"
    else default_b=""
    fi
  fi

  [ -z "$default_b" ] && continue

  # Ensure local tracks the right branch
  local_b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if [ "$local_b" = "HEAD" ] || [ -z "$local_b" ]; then
    echo "[self-heal] $repo_name: detached HEAD -> checkout $default_b"
    git checkout "$default_b" 2>/dev/null || git checkout -b "$default_b" "origin/$default_b" 2>/dev/null || true
  fi

  # Update DB
  sqlite3 "$DB_PATH" "UPDATE repositories SET default_branch='$default_b' WHERE name='$repo_name';" 2>/dev/null || true
done

echo "[self-heal] done"
