#!/bin/bash
set -euo pipefail

log() {
    printf '[worktree-init] %s\n' "$*"
}

if [ -z "${REPO_ROOT:-}" ]; then
    printf '[worktree-init] REPO_ROOT must be set to the main checkout path.\n' >&2
    exit 1
fi

if [ ! -d "$REPO_ROOT" ]; then
    printf '[worktree-init] REPO_ROOT is not a directory: %s\n' "$REPO_ROOT" >&2
    exit 1
fi

# dtree runs this from the new worktree and sets REPO_ROOT to the primary
# checkout. Copy this file into a project as .worktree-init.sh (or
# scripts/worktree-init.sh) and adapt it for project-specific setup.
if [ ! -e .env ] && [ ! -L .env ] && [ -f "$REPO_ROOT/.env" ]; then
    ln -s "$REPO_ROOT/.env" .env
    log "Linked .env from main checkout"
fi

if [ -f package-lock.json ]; then
    log "Installing dependencies with npm ci"
    npm ci
fi

# Share Terraform initialization data with the main checkout. Do not replace
# an existing worktree-specific directory or symlink. Use an absolute source
# path because these directories may be nested below the worktree root.
repo_root="$(cd "$REPO_ROOT" && pwd -P)"
find "$repo_root/terraform" -type d -name .terraform -print 2>/dev/null |
while IFS= read -r terraform_dir; do
    relative_dir="${terraform_dir#"$repo_root"/}"

    if [ ! -e "$relative_dir" ] && [ ! -L "$relative_dir" ]; then
        mkdir -p "$(dirname "$relative_dir")"
        ln -s "$terraform_dir" "$relative_dir"
        log "Linked $relative_dir from main checkout"
    fi
done
