# rancher-desktop uses non-interactive bash shell
export PATH="$HOME/.rd/bin:$PATH"

if [ -r "${CARGO_HOME:-$HOME/.cargo}/env" ]; then
  . "${CARGO_HOME:-$HOME/.cargo}/env"
fi
