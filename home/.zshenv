# Read by every zsh, including non-interactive ones (IDE and agent shells, git hooks run
# from GUI clients), which never read .zshrc. Keep this file small and fast.

# Keep one managed Pi launcher ahead of nvm's per-Node npm globals, including
# in non-interactive shells. This directory contains Pi, not a replacement Node.
prefer-managed-pi() {
  local managed_pi_bin="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin"
  if [[ -x "$managed_pi_bin/pi" ]]; then
    typeset -gU path PATH
    path=("$managed_pi_bin" "${path[@]}")
  fi
}
prefer-managed-pi

# Rancher must also be discoverable from non-interactive shells and Pi children.
typeset -gU path PATH
path=("$HOME/.rd/bin" "${path[@]}")

# https://docs.rancherdesktop.io/how-to-guides/using-testcontainers/
# Reused by the interactive prompt hook when Rancher starts after the shell.
# Exports all Rancher settings or none, so workloads never see a partial setup.
configure-rancher-desktop() {
  local rancher_host="unix://$HOME/.rd/docker.sock"
  [[ -S "$HOME/.rd/docker.sock" && "${DOCKER_HOST:-$rancher_host}" == "$rancher_host" ]] || return 0
  local rancher_ip="${TESTCONTAINERS_HOST_OVERRIDE:-}"
  if [[ -z "$rancher_ip" ]]; then
    if ! rancher_ip=$(rdctl info --field ip-address) || [[ -z "$rancher_ip" ]]; then
      print -u2 -- "Rancher socket exists, but rdctl could not determine its IP address; Docker settings were not exported."
      return 1
    fi
  fi
  export DOCKER_HOST="$rancher_host"
  export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE="${TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE:-/var/run/docker.sock}"
  export TESTCONTAINERS_RYUK_DISABLED="${TESTCONTAINERS_RYUK_DISABLED:-true}"
  export TESTCONTAINERS_HOST_OVERRIDE="$rancher_ip"
}
# A Rancher failure must not kill every shell (sandboxed agent shells cannot reach
# rdctl). Docker work fails on its own because nothing above was exported.
configure-rancher-desktop || true
