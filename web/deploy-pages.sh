#!/usr/bin/env bash
set -euo pipefail

# Publishes web/dist to the gh-pages branch, which GitHub Pages serves for free.
cd "$(dirname "$0")/.."
REMOTE=$(git remote get-url origin)

bun web/build.ts

cd web/dist
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "Publish the static site"
git push -q --force "$REMOTE" gh-pages
rm -rf .git
echo "pushed gh-pages"
