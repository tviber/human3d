#!/bin/sh
# Caps the Node/ffmpeg processes that THIS repository runs (any of its git
# worktrees), not the whole machine: editors, coding agents and unrelated Node
# services never block a build or test. A process counts when its command line
# names a path inside a checkout, or when it is a repo-style command (relative
# repo path, npm/npx/vite/vitest/tsx) whose working directory is a checkout.
# Editor TypeScript servers are excluded even when they load our node_modules.
# `--list` prints the counted processes (used by scripts/lib/process-lock.mjs).
set -eu

LIMIT=4
mode=check
additional=1
case "${1:-}" in
  '') ;;
  --npx) additional=2 ;;
  --list) mode=list ;;
  *) printf '%s\n' 'Usage: sh scripts/check-process-limit.sh [--npx|--list]' >&2; exit 2 ;;
esac

refuse_unchecked(){
  printf 'Cannot check the H3D process limit (%s); refusing to start.\n' "$1" >&2
  exit 3
}

newline='
'
here=$(cd "$(dirname "$0")/.." && pwd -P)
roots="$here"
add_root(){
  real=$(cd "$1" 2>/dev/null && pwd -P) || return 0
  case "$newline$roots$newline" in
    *"$newline$real$newline"*) ;;
    *) roots="$roots$newline$real" ;;
  esac
}
worktrees=$(git -C "$here" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p') || worktrees=''
old_ifs=$IFS; IFS=$newline
for root in $worktrees; do add_root "$root"; done
IFS=$old_ifs

inside_root(){
  old_ifs=$IFS; IFS=$newline
  for root in $roots; do
    case "$1/" in
      "$root"/*) IFS=$old_ifs; return 0 ;;
    esac
  done
  IFS=$old_ifs; return 1
}

cwd_of(){
  if [ -e "/proc/$1/cwd" ]; then readlink "/proc/$1/cwd" 2>/dev/null && return 0; fi
  if command -v lsof >/dev/null 2>&1; then lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; fi
}

command -v ps >/dev/null 2>&1 || refuse_unchecked 'ps unavailable'
process_list=$(ps -A -ww -o pid= -o args=) || refuse_unchecked 'ps failed'

# "A pid args": names a checkout path. "C pid args": a repo-style command that
# counts only when its working directory is a checkout.
candidates=$(printf '%s\n' "$process_list" | H3D_ROOTS="$roots" awk '
  BEGIN{n=split(ENVIRON["H3D_ROOTS"],roots,"\n")}
  {
    pid=$1; args=$0; sub(/^[[:space:]]*[0-9]+[[:space:]]+/,"",args)
    name=tolower($2); sub(/^.*\//,"",name)
    if(name !~ /^(node(js)?|npm|npx|pnpm|yarn|bun|tsx|vite|vitest|ffmpeg)([._-]|$)/)next
    if(tolower(args) ~ /(tsserver|typingsinstaller|language-server)/)next
    for(i=1;i<=n;i++)if(roots[i]!=""&&index(args,roots[i] "/")){print "A " pid " " args;next}
    for(i=3;i<=NF;i++)if($i ~ /^(\.\/)?(scripts|apps|packages|tests|spec|node_modules)\//){print "C " pid " " args;next}
    if(name ~ /^(npm|npx|pnpm|yarn|vite|vitest|tsx)([._-]|$)/)print "C " pid " " args
  }')

owned=''
old_ifs=$IFS; IFS=$newline
for line in $candidates; do
  IFS=$old_ifs
  kind=${line%% *}; rest=${line#* }; pid=${rest%% *}
  if [ "$kind" = C ]; then
    cwd=$(cwd_of "$pid" || true)
    # An unreadable working directory counts as ours: over-counting only delays a run.
    if [ -n "$cwd" ] && ! inside_root "$cwd"; then IFS=$newline; continue; fi
  fi
  owned="$owned$rest$newline"
  IFS=$newline
done
IFS=$old_ifs

if [ "$mode" = list ]; then
  printf '%s' "$owned"
  exit 0
fi

count=$(printf '%s' "$owned" | grep -c . || true)
if [ "$count" -gt "$((LIMIT - additional))" ]; then
  printf 'Refusing to start: %s H3D Node/ffmpeg processes are already active; this command may start %s more, and the H3D limit is %s.\n%s' "$count" "$additional" "$LIMIT" "$owned" >&2
  exit 3
fi
