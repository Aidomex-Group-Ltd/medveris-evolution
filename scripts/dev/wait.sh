#!/usr/bin/env bash
# Poll a background command started with scripts/dev/bg.sh for at most 25 s.
# Usage: scripts/dev/wait.sh <name>
# Prints EXIT <code> when finished (exit 0) or RUNNING (exit 1) on timeout.
set -uo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <name>" >&2
  exit 64
fi

name=$1
status_file=".logs/$name.status"

for _ in $(seq 1 25); do
  if [ -f "$status_file" ]; then
    code=$(cat "$status_file")
    echo "EXIT $code"
    if [ "$code" -eq 0 ]; then
      exit 0
    fi
    exit 1
  fi
  sleep 1
done

echo "RUNNING"
exit 1
