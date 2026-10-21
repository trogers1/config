#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home/.pi/agent/bin" "$tmp/node-old" "$tmp/node-new"
for bin in "$tmp/home/.pi/agent/bin" "$tmp/node-old" "$tmp/node-new"; do
  printf '#!/bin/sh\nexit 0\n' > "$bin/pi"
  chmod +x "$bin/pi"
done
for bin in "$tmp/node-old" "$tmp/node-new"; do
  printf '#!/bin/sh\nexit 0\n' > "$bin/node"
  chmod +x "$bin/node"
done

HOME="$tmp/home" PI_CODING_AGENT_DIR= REPO="$repo" TEST_ROOT="$tmp" zsh -f <<'ZSH'
set -eu
source "$REPO/home/.zshenv"
managed="$HOME/.pi/agent/bin"
for node_bin in "$TEST_ROOT/node-old" "$TEST_ROOT/node-new"; do
  path=("$node_bin" "${path[@]}")
  prefer-managed-pi
  prefer-managed-pi
  [[ "$(command -v pi)" == "$managed/pi" ]]
  [[ "$(command -v node)" == "$node_bin/node" ]]
  occurrences=0
  for entry in "${path[@]}"; do
    if [[ "$entry" == "$managed" ]]; then (( ++occurrences )); fi
  done
  [[ "$occurrences" == 1 ]]
done
# Respect an explicitly configured agent directory too.
export PI_CODING_AGENT_DIR="$TEST_ROOT/custom-agent"
mkdir -p "$PI_CODING_AGENT_DIR/bin"
cp "$managed/pi" "$PI_CODING_AGENT_DIR/bin/pi"
prefer-managed-pi
[[ "$(command -v pi)" == "$PI_CODING_AGENT_DIR/bin/pi" ]]
ZSH

# Without a managed installation, preserve the existing command resolution.
HOME="$tmp/missing-home" PI_CODING_AGENT_DIR= REPO="$repo" TEST_ROOT="$tmp" zsh -f <<'ZSH'
set -eu
path=("$TEST_ROOT/node-old" "${path[@]}")
source "$REPO/home/.zshenv"
[[ "$(command -v pi)" == "$TEST_ROOT/node-old/pi" ]]
ZSH
printf 'Managed Pi PATH tests passed\n'
