#!/bin/sh
# Apply an updated arbitrade-rebuild.tar over the current project tree.
# Auto-picks the NEWEST matching tar in ~/Downloads (handles browser-added
# "(1)", "(2)" suffixes for duplicate downloads). Shows the tar's timestamp
# so you know what you're applying. Refuses to apply older versions than the
# last one you applied.
#
# Preserves: .env, node_modules/, db/, .git/  (nothing in the tar touches them)
# Archives:  each applied tar into build/tarballs/<timestamp>.tar for history
#
# Usage: yarn apply                        # newest arbitrade-rebuild*.tar in ~/Downloads
#        yarn apply path/to/specific.tar   # explicit path
set -e

# 1. Locate the tar
if [ -n "$1" ]; then
    TAR="$1"
else
    # Find the newest matching tar by mtime — handles "(1)", "(2)" suffixes
    TAR=$(ls -t "$HOME/Downloads"/arbitrade-rebuild*.tar 2>/dev/null | head -1)
fi

if [ -z "$TAR" ] || [ ! -f "$TAR" ]; then
    echo "No arbitrade-rebuild tar found in ~/Downloads." >&2
    echo "Usage: yarn apply [path/to/tar]" >&2
    exit 1
fi

# 2. Show what we're about to apply, so you can spot "wait, that's yesterday's"
TAR_MTIME=$(stat -c %Y "$TAR" 2>/dev/null || stat -f %m "$TAR")   # linux || macos
TAR_DATE=$(date -d "@$TAR_MTIME" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -r "$TAR_MTIME" '+%Y-%m-%d %H:%M:%S')
TAR_SIZE=$(stat -c %s "$TAR" 2>/dev/null || stat -f %z "$TAR")
echo "Tar:  $TAR"
echo "Date: $TAR_DATE  (size: $TAR_SIZE bytes)"

# 3. Refuse to apply older-than-last
ARCHIVE_DIR="build/tarballs"
mkdir -p "$ARCHIVE_DIR"
LAST_APPLIED=$(ls -t "$ARCHIVE_DIR"/*.tar 2>/dev/null | head -1)
if [ -n "$LAST_APPLIED" ]; then
    LAST_MTIME=$(stat -c %Y "$LAST_APPLIED" 2>/dev/null || stat -f %m "$LAST_APPLIED")
    if [ "$TAR_MTIME" -le "$LAST_MTIME" ]; then
        LAST_DATE=$(date -d "@$LAST_MTIME" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -r "$LAST_MTIME" '+%Y-%m-%d %H:%M:%S')
        echo "" >&2
        echo "[!] This tar ($TAR_DATE) is NOT newer than the last one you applied ($LAST_DATE)." >&2
        echo "    Either you're re-applying the same one, or the download didn't refresh." >&2
        printf "    Apply anyway? [y/N] "
        read -r ANS
        case "$ANS" in
            y|Y|yes|YES) ;;
            *) echo "Aborted."; exit 1 ;;
        esac
    fi
fi

# 4. Archive with timestamp — build/tarballs/ becomes your version history
STAMP=$(date '+%Y%m%d-%H%M%S')
cp "$TAR" "$ARCHIVE_DIR/arbitrade-rebuild-$STAMP.tar"

# 5. Extract
echo ""
echo "Extracting..."
tar -xf "$TAR"

# 6. Clean up the downloaded copy so it doesn't accumulate + can't be re-applied
if [ -z "$1" ]; then
    rm -f "$TAR"
    echo "Removed $TAR (archived copy kept at $ARCHIVE_DIR/arbitrade-rebuild-$STAMP.tar)"
fi

# 7. Show what changed so you can immediately see the update landed
echo ""
if [ -d .git ]; then
    CHANGED=$(git status --short 2>/dev/null | wc -l)
    if [ "$CHANGED" -eq 0 ]; then
        echo "No files changed (identical to your working tree)."
    else
        echo "$CHANGED file(s) changed:"
        git status --short
    fi
else
    echo "(not a git repo — run \`yarn sync\` once to set one up)"
fi

