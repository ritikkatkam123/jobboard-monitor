#!/usr/bin/env bash
# Persist monitoring snapshots on a dedicated git branch between GitHub Actions runs.
#
# Runners are wiped after every job, and caches can be evicted at any time, so neither
# is durable history. Instead, snapshots live on an orphan branch (no shared history
# with the source code), checked out next to the source in a separate worktree.
#
#   scripts/state-branch.sh restore <dir>   # check out the state branch into <dir>
#   scripts/state-branch.sh save <dir> <message>   # commit <dir>/state and push it
#
# Environment: STATE_BRANCH (default: monitor-state), REMOTE (default: origin).
set -euo pipefail

BRANCH="${STATE_BRANCH:-monitor-state}"
REMOTE="${REMOTE:-origin}"

usage() {
  echo "usage: $0 restore <dir> | save <dir> <message>" >&2
  exit 2
}

restore() {
  local dir="$1"
  if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
    git fetch --quiet --depth=1 "$REMOTE" "$BRANCH"
    git worktree add --detach "$dir" FETCH_HEAD >/dev/null 2>&1
    echo "Restored state from branch '$BRANCH' into $dir"
  else
    # First run: start an empty orphan branch.
    git worktree add --detach "$dir" >/dev/null 2>&1
    (
      cd "$dir"
      git checkout --quiet --orphan "$BRANCH"
      git rm -r --quiet --force . >/dev/null 2>&1 || true
      git clean -fdq
      cat >README.md <<'EOF'
# monitor-state

Snapshots written by the scheduled JobBoard Monitor workflow. Do not merge this
branch into the source branch; it shares no history with it on purpose.
EOF
    )
    echo "Branch '$BRANCH' does not exist yet; starting with empty state in $dir"
  fi
  mkdir -p "$dir/state"
}

save() {
  local dir="$1" message="$2"
  cd "$dir"
  git add -A state README.md 2>/dev/null || git add -A state
  if git diff --cached --quiet; then
    echo "No snapshot changes to save"
    return 0
  fi
  git -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit --quiet -m "$message"
  git push --quiet "$REMOTE" "HEAD:refs/heads/$BRANCH"
  echo "Saved state to branch '$BRANCH'"
}

case "${1:-}" in
  restore) [[ $# -eq 2 ]] || usage; restore "$2" ;;
  save) [[ $# -eq 3 ]] || usage; save "$2" "$3" ;;
  *) usage ;;
esac
