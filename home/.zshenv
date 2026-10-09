# Read by every zsh, including non-interactive ones (IDE and agent shells, git hooks run
# from GUI clients), which never read .zshrc. Keep this file small and fast.

# Rancher Desktop uses a per-user Docker socket; tools that don't read the Docker context
# (testcontainers) need DOCKER_HOST. Docker Desktop's default socket needs nothing.
# https://docs.rancherdesktop.io/how-to-guides/using-testcontainers/
# .zshrc adds TESTCONTAINERS_HOST_OVERRIDE (it calls rdctl, too slow for every shell).
if [[ -z "${DOCKER_HOST:-}" && -S "$HOME/.rd/docker.sock" ]]; then
  export DOCKER_HOST="unix://$HOME/.rd/docker.sock"
  export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
  export TESTCONTAINERS_RYUK_DISABLED=true
fi
