#!/usr/bin/env bash
# Run a potentially long command detached from the calling shell.
# Usage: scripts/dev/bg.sh <name> <command...>
# The command string is executed with bash -c; logs go to .logs/<name>.log and
# the exit code to .logs/<name>.status. Poll with scripts/dev/wait.sh <name>.
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <name> <command...>" >&2
  exit 64
fi

name=$1
shift
mkdir -p .logs
rm -f ".logs/$name.status" ".logs/$name.pid"

(
  nohup bash -c "$*" >".logs/$name.log" 2>&1
  echo $? >".logs/$name.status"
) >/dev/null 2>&1 &
echo $! >".logs/$name.pid"

echo "started $name pid=$(cat ".logs/$name.pid") log=.logs/$name.log"
