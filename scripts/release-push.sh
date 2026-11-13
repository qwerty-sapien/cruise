#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/release-push.sh [--dry-run] [remote] [branch]

Collapse commits between the two newest first-parent release commits into the
newest release, preserve commits made after that release, then push with an
exact force-with-lease.

Release subjects must begin with "vX.Y.Z" or "Cruise vX.Y.Z".

Examples:
  scripts/release-push.sh --dry-run origin main
  scripts/release-push.sh origin main
  npm run release:push -- origin main
EOF
}

die() {
  printf 'release-push: %s\n' "$*" >&2
  exit 1
}

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
  shift
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

remote="${1:-origin}"
current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" ||
  die "HEAD is detached; check out the production branch first"
branch="${2:-$current_branch}"

[[ $# -le 2 ]] || {
  usage >&2
  exit 2
}

git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  die "run this command inside a Git worktree"
git check-ref-format --branch "$branch" >/dev/null 2>&1 ||
  die "invalid branch name: $branch"
git remote get-url "$remote" >/dev/null 2>&1 ||
  die "unknown remote: $remote"
[[ "$current_branch" == "$branch" ]] ||
  die "checked-out branch is $current_branch, not $branch"
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] ||
  die "worktree or index is dirty; commit, stash, or remove those changes first"

original_head="$(git rev-parse "refs/heads/$branch")"
git fetch --no-tags "$remote" "refs/heads/$branch"
remote_tip="$(git rev-parse FETCH_HEAD)"

git merge-base --is-ancestor "$remote_tip" "$original_head" ||
  die "$remote/$branch is not an ancestor of local $branch; integrate remote changes first"

release_commits="$(
  git log --first-parent --format='%H%x09%s' "$original_head" |
    awk -F '	' '
      $2 ~ /^(Cruise )?v[0-9]+\.[0-9]+\.[0-9]+([:[:space:]]|$)/ {
        print $1
        found += 1
        if (found == 2) exit
      }
    '
)"
latest_release="$(printf '%s\n' "$release_commits" | sed -n '1p')"
previous_release="$(printf '%s\n' "$release_commits" | sed -n '2p')"

[[ -n "$latest_release" && -n "$previous_release" ]] ||
  die "could not find two first-parent release commits"
git merge-base --is-ancestor "$previous_release" "$latest_release" ||
  die "release commits are not in a linear first-parent history"

merge_commits="$(git rev-list --min-parents=2 "$previous_release..$original_head")"
[[ -z "$merge_commits" ]] ||
  die "merge commits exist after the previous release; flatten them manually"

release_range_count="$(git rev-list --count "$previous_release..$latest_release")"
post_release_count="$(git rev-list --count "$latest_release..$original_head")"
intermediate_count=$((release_range_count - 1))
latest_subject="$(git show -s --format='%s' "$latest_release")"
previous_subject="$(git show -s --format='%s' "$previous_release")"

if git merge-base --is-ancestor "$latest_release" "$remote_tip" &&
  [[ "$intermediate_count" -eq 0 ]]; then
  die "the newest release is already on $remote/$branch and has no intermediate commits to remove"
fi

printf 'Previous release: %s (%s)\n' "$previous_subject" "${previous_release:0:12}"
printf 'Newest release:   %s (%s)\n' "$latest_subject" "${latest_release:0:12}"
printf 'Will remove:      %s intermediate commit(s)\n' "$intermediate_count"
printf 'Will preserve:    %s post-release commit(s)\n' "$post_release_count"
printf 'Remote lease:     %s\n' "${remote_tip:0:12}"

if [[ "$dry_run" -eq 1 ]]; then
  printf 'Dry run only; no refs were changed and nothing was pushed.\n'
  exit 0
fi

if [[ "$intermediate_count" -eq 0 ]]; then
  git push "$remote" "refs/heads/$branch:refs/heads/$branch"
  pushed_tip="$(git ls-remote "$remote" "refs/heads/$branch" | awk '{print $1}')"
  [[ "$pushed_tip" == "$original_head" ]] ||
    die "remote verification failed: expected $original_head, found ${pushed_tip:-nothing}"
  printf 'No intermediate commits required rewriting; pushed %s normally.\n' "$branch"
  exit 0
fi

tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/cruise-release-push.XXXXXX")"
cleanup() {
  [[ -n "${tmp_root:-}" && -d "$tmp_root" ]] && rm -rf -- "$tmp_root"
}
trap cleanup EXIT

recreate_commit() {
  local source_commit="$1"
  local new_parent="$2"
  local message_file="$tmp_root/message"
  local tree author_name author_email author_date
  local committer_name committer_email committer_date

  tree="$(git rev-parse "$source_commit^{tree}")"
  git show -s --format='%B' "$source_commit" >"$message_file"
  author_name="$(git show -s --format='%an' "$source_commit")"
  author_email="$(git show -s --format='%ae' "$source_commit")"
  author_date="$(git show -s --format='%aI' "$source_commit")"
  committer_name="$(git show -s --format='%cn' "$source_commit")"
  committer_email="$(git show -s --format='%ce' "$source_commit")"
  committer_date="$(git show -s --format='%cI' "$source_commit")"

  GIT_AUTHOR_NAME="$author_name" \
    GIT_AUTHOR_EMAIL="$author_email" \
    GIT_AUTHOR_DATE="$author_date" \
    GIT_COMMITTER_NAME="$committer_name" \
    GIT_COMMITTER_EMAIL="$committer_email" \
    GIT_COMMITTER_DATE="$committer_date" \
    git commit-tree "$tree" -p "$new_parent" <"$message_file"
}

signed_commits="$(
  {
    printf '%s\n' "$latest_release"
    git rev-list --first-parent "$latest_release..$original_head"
  } |
    while read -r commit; do
      if git cat-file commit "$commit" |
        awk '/^gpgsig / { found = 1 } END { exit(found ? 0 : 1) }'; then
        printf '%s\n' "$commit"
      fi
    done
)"
if [[ -n "$signed_commits" ]]; then
  printf 'Warning: rewritten signed commits receive new unsigned commit objects.\n' >&2
fi

new_release="$(recreate_commit "$latest_release" "$previous_release")"

new_tip="$new_release"
while read -r post_release_commit; do
  [[ -n "$post_release_commit" ]] || continue
  new_tip="$(recreate_commit "$post_release_commit" "$new_tip")"
done < <(git rev-list --first-parent --reverse "$latest_release..$original_head")

git diff --quiet "$latest_release" "$new_release" ||
  die "rewritten release tree differs from the source release"
git diff --quiet "$original_head" "$new_tip" ||
  die "rewritten final tree differs from the original branch tip"
[[ "$(git rev-parse "$new_release^")" == "$previous_release" ]] ||
  die "rewritten release does not directly follow the previous release"
expected_count=$((post_release_count + 1))
actual_count="$(git rev-list --count "$previous_release..$new_tip")"
[[ "$actual_count" -eq "$expected_count" ]] ||
  die "rewritten history contains $actual_count commits; expected $expected_count"

safe_branch="$(printf '%s' "$branch" | tr '/ ' '--' | tr -cd '[:alnum:]_.-')"
backup_branch="codex/history-backup-${safe_branch}-$(date -u +%Y%m%dT%H%M%SZ)"
suffix=1
while git show-ref --verify --quiet "refs/heads/$backup_branch"; do
  backup_branch="codex/history-backup-${safe_branch}-$(date -u +%Y%m%dT%H%M%SZ)-$suffix"
  suffix=$((suffix + 1))
done
git branch "$backup_branch" "$original_head"

git update-ref \
  -m "collapse intermediate commits into $latest_subject" \
  "refs/heads/$branch" \
  "$new_tip" \
  "$original_head"

if ! git push "$remote" \
  "refs/heads/$branch:refs/heads/$branch" \
  "--force-with-lease=refs/heads/$branch:$remote_tip"; then
  git update-ref \
    -m "restore after failed release push" \
    "refs/heads/$branch" \
    "$original_head" \
    "$new_tip"
  die "push failed; local $branch was restored and $backup_branch was retained"
fi

pushed_tip="$(git ls-remote "$remote" "refs/heads/$branch" | awk '{print $1}')"
[[ "$pushed_tip" == "$new_tip" ]] ||
  die "remote verification failed: expected $new_tip, found ${pushed_tip:-nothing}"

printf 'Pushed cleaned %s to %s at %s.\n' "$branch" "$remote" "${new_tip:0:12}"
printf 'Local backup: %s (%s)\n' "$backup_branch" "${original_head:0:12}"
