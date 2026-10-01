#!/bin/sh
# Installs agent-collab-kit on this machine (macOS, Linux): ./install.sh from this folder.
# It only checks Node and runs bin/agent-collab-kit-install from the folder it sits in; arguments are passed on
# (for example: ./install.sh --dry-run).
here=$(cd "$(dirname "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 20.19 or newer (https://nodejs.org) and run this again."
  exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)"; then
  echo "Node.js 20.19 or newer is needed; this machine has $(node -v). Update it (https://nodejs.org) and run this again."
  exit 1
fi
node "$here/bin/agent-collab-kit-install" --source "$here" "$@"
code=$?
echo
if [ "$code" -eq 0 ]; then
  echo "Done. Open a new terminal, then in your project folder run:  collab connect"
else
  echo "The installation did not finish, and it leaves nothing half-done. The lines above say why."
fi
exit "$code"
