#!/usr/bin/env bash
# Bootstrap entrypoint for pi-shared resources.
#
# Usage:
#   ./install.sh [--force] [--no-catalog]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/bin/pi-shared-install" "$@"
