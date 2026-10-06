#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'Usage: DEPLOY_HOST=<ssh-target> deploy/deploy.sh <instance> <commit>' >&2
  echo '       DEPLOY_HOST=<ssh-target> deploy/deploy.sh --rollback <instance>' >&2
  exit 2
}

mode=deploy
if [[ ${1:-} == --rollback ]]; then
  [[ $# == 2 ]] || usage
  mode=rollback
  instance=$2
else
  [[ $# == 2 ]] || usage
  instance=$1
fi
[[ $instance =~ ^[a-z][a-z0-9-]{0,31}$ ]] || usage
: "${DEPLOY_HOST:?Set DEPLOY_HOST to an SSH target with root privileges}"
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
commit=rollback
if [[ $mode == deploy ]]; then
  commit=$(git -C "$root" rev-parse --verify --end-of-options "$2^{commit}")
fi

# The remote shell receives fixed code and validated arguments; stdin carries the archive.
remote=$(cat <<'REMOTE'
set -euo pipefail
instance=$1
mode=$2
commit=$3
live=/opt/dusk-domains-indexer-$instance
next=$live-next
env_file=/etc/dusk-domains/$instance.env
collector=dusk-domains-collector@$instance.service
api=dusk-domains-indexer@$instance.service
exec 9>"/var/lock/dusk-domains-deploy-$instance.lock"
flock -n 9 || { echo "Another deployment is running for $instance" >&2; exit 1; }
test -f "$env_file"
port=$(node --input-type=module -e '
  import { readFileSync } from "node:fs"
  import { parseEnv } from "node:util"
  const port = parseEnv(readFileSync(process.argv[1], "utf8")).DUSK_DOMAINS_INDEXER_PORT
  if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) process.exit(1)
  console.log(port)
' "$env_file")
stamp=$(date -u +%Y%m%dT%H%M%S%NZ)
previous=$live.prev-$stamp
shopt -s nullglob
if [[ $mode == rollback ]]; then
  releases=("$live".prev-*)
  ((${#releases[@]})) || { echo "No previous release for $instance" >&2; exit 1; }
  candidate=${releases[-1]}
  commit=$(cat "$candidate/.source-commit")
  [[ $commit =~ ^[0-9a-f]{40}$ ]]
  # The release rolled back from is set aside, so another rollback goes further back.
  previous=$live.failed-$stamp
else
  test ! -e "$next"
  mkdir "$next"
  tar -xf - -C "$next"
  (cd "$next" && npm ci --no-audit --no-fund)
  printf '%s\n' "$commit" > "$next/.source-commit"
  chown -R duskdomains:duskdomains "$next"
  candidate=$next
fi

# Preserve the migrated single-instance release's identity for its first rollback.
if [[ -d $live && ! -f $live/.source-commit ]]; then
  old_commit=$(node --input-type=module -e '
    import { readFileSync } from "node:fs"
    import { parseEnv } from "node:util"
    const commit = parseEnv(readFileSync(process.argv[1], "utf8")).DUSK_DOMAINS_INDEXER_SOURCE_COMMIT
    if (!/^[0-9a-f]{40}$/.test(commit)) process.exit(1)
    console.log(commit)
  ' "$env_file")
  printf '%s\n' "$old_commit" > "$live/.source-commit"
fi
# Prepare the env update before stopping services, preserving its owner and permissions.
cp -p "$env_file" "$env_file.next"
sed -i '/^DUSK_DOMAINS_INDEXER_SOURCE_COMMIT=/d' "$env_file.next"
printf '\nDUSK_DOMAINS_INDEXER_SOURCE_COMMIT=%s\n' "$commit" >> "$env_file.next"
# A failure mid-swap puts the running release and its env back and restarts it.
moved_live=false
placed=false
undo() {
  echo "Swap failed for $instance; restoring the running release" >&2
  if $placed; then mv "$live" "$candidate"; fi
  if $moved_live; then mv "$previous" "$live"; fi
  rm -f "$env_file.next"
  systemctl restart "$collector" "$api"
}
trap undo ERR
systemctl stop "$api" "$collector"
if [[ -d $live ]]; then mv "$live" "$previous"; moved_live=true; fi
mv "$candidate" "$live"
placed=true
mv "$env_file.next" "$env_file"
trap - ERR
systemctl restart "$collector" "$api"

# Old releases go only after a healthy start, so failed attempts never remove the last good one.
prune() {
  local kind releases
  for kind in prev failed; do
    releases=("$live".$kind-*)
    while ((${#releases[@]} > 3)); do
      rm -rf -- "${releases[0]}"
      releases=("${releases[@]:1}")
    done
  done
}
for ((attempt=0; attempt<30; attempt++)); do
  if systemctl is-active --quiet "$collector" && systemctl is-active --quiet "$api" &&
    curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$port/health" |
      node --input-type=module -e '
        let text = ""
        for await (const chunk of process.stdin) text += chunk
        const health = JSON.parse(text)
        if (health.ok !== true || health.package?.sourceCommit !== process.argv[1]) process.exit(1)
      ' "$commit"; then
    echo "$instance healthy at $commit on port $port"
    prune
    exit 0
  fi
  sleep 2
done
echo "$instance failed its health check; inspect the journal or use --rollback $instance" >&2
exit 1
REMOTE
)
# Single-quote the script for the login shell used by SSH.
quoted_remote="'${remote//\'/\'\\\'\'}'"
command="bash -c $quoted_remote -- '$instance' '$mode' '$commit'"
if [[ $mode == deploy ]]; then
  git -C "$root" archive --format=tar "$commit" | ssh -o BatchMode=yes -- "$DEPLOY_HOST" "$command"
else
  ssh -o BatchMode=yes -- "$DEPLOY_HOST" "$command" < /dev/null
fi
