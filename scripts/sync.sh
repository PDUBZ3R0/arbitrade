#!/bin/sh
# Commit local changes and push to the arbitrade GitHub repo.
# First run does the initial setup (git init, remote add, initial commit).
# Subsequent runs commit + push in one shot.
#
# Usage: yarn sync ["commit message"]
#        (message defaults to a timestamp)
set -e

REMOTE_URL="git@github.com:PDUBZ3R0/arbitrade.git"
MSG="${1:-sync $(date '+%Y-%m-%d %H:%M')}"

# First run: init repo, add remote, warn if we can't reach it
if [ ! -d .git ]; then
    echo "First-time setup: initializing git repo"
    git init -b main
    git remote add origin "$REMOTE_URL"
    echo "Remote 'origin' set to $REMOTE_URL"
    echo ""
    echo "NEXT STEPS after this commit:"
    echo "  1. Confirm the repo exists on GitHub (create it there if not)"
    echo "  2. First push: git push -u origin main"
    echo "     (if the remote already has commits, use --force-with-lease with care)"
fi

# Make sure the remote points where we expect (fixes stale URLs)
CURRENT_REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
if [ "$CURRENT_REMOTE" != "$REMOTE_URL" ]; then
    echo "Updating origin: $CURRENT_REMOTE -> $REMOTE_URL"
    git remote set-url origin "$REMOTE_URL" 2>/dev/null || git remote add origin "$REMOTE_URL"
fi

# Stage + commit + push
git add -A
if git diff --cached --quiet; then
    echo "Nothing to commit."
else
    git commit -m "$MSG"
fi

# Only auto-push after initial `git push -u`; otherwise print instruction
BRANCH=$(git branch --show-current 2>/dev/null || echo main)
if git rev-parse --abbrev-ref "@{u}" >/dev/null 2>&1; then
    git push
else
    echo ""
    echo "No upstream set for '$BRANCH'. Run once:"
    echo "  git push -u origin $BRANCH"
fi
