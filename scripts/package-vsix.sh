#!/usr/bin/env bash
set -e

# Change directory to the project root directory (where package.json resides)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Usage:
#   npm run vsix                  -> bumps patch version (default) and packages .vsix
#   npm run vsix -- minor         -> bumps minor version and packages .vsix
#   npm run vsix -- major         -> bumps major version and packages .vsix
#   npm run vsix -- 1.0.0         -> bumps to specific version and packages .vsix
#   npm run vsix -- --no-bump     -> packages .vsix with current version (no bump)
#   npm run vsix -- patch [opts]  -> bumps version with extra vsce options

CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "📦 Current extension version: v${CURRENT_VERSION}"

EXTRA_ARGS=()
# If git repo has uncommitted changes, add --no-git-tag-version to prevent npm version error
if [ -d .git ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    HAS_TAG_FLAG=0
    for arg in "$@"; do
        if [[ "$arg" == "--no-git-tag-version" ]]; then
            HAS_TAG_FLAG=1
            break
        fi
    done
    if [ $HAS_TAG_FLAG -eq 0 ]; then
        echo "ℹ️  Git working tree has unstaged changes; skipping git tag creation (--no-git-tag-version)."
        EXTRA_ARGS+=("--no-git-tag-version")
    fi
fi

if [ "$1" = "--no-bump" ] || [ "$1" = "current" ]; then
    shift
    echo "🔨 Packaging VSIX without version bump..."
    npx vsce package "$@"
elif [[ "$1" =~ ^- ]]; then
    echo "🚀 Bumping patch version and packaging VSIX..."
    npx vsce package patch "${EXTRA_ARGS[@]}" "$@"
else
    BUMP_TYPE="${1:-patch}"
    if [ $# -gt 0 ]; then
        shift
    fi
    echo "🚀 Bumping version (${BUMP_TYPE}) and packaging VSIX..."
    npx vsce package "$BUMP_TYPE" "${EXTRA_ARGS[@]}" "$@"
fi

NEW_VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
VSIX_FILE="${NAME}-${NEW_VERSION}.vsix"

if [ -f "$VSIX_FILE" ]; then
    echo "✅ Successfully created ${VSIX_FILE} (v${NEW_VERSION})"
fi
