#!/bin/bash
set -e

MESSAGE=${1:-"chore: deploy $(date +%Y-%m-%d %H:%M)"}

echo "→ Staging all changes..."
git add -A

if git diff --cached --quiet; then
  echo "→ Nothing to commit — pushing existing HEAD to prod..."
else
  echo "→ Committing: $MESSAGE"
  git commit -m "$MESSAGE"
fi

echo "→ Pushing to GitHub (origin/main)..."
git push origin main

echo ""
echo "✓ GitHub is up to date."
echo "  Coolify will auto-deploy → https://plusim.xyz"
echo "  Watch progress: http://178.104.184.3:8000"
