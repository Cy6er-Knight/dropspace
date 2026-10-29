#!/bin/bash
# Double-click this file on a Mac to start Dropspace.
cd "$(dirname "$0")" || exit 1

# Finder starts this without your usual shell setup, so look in the common places Node gets installed.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Dropspace needs Node.js, which is free. Opening the download page now."
  echo "  Install it (the LTS version), then double-click Start Dropspace again."
  echo ""
  open "https://nodejs.org/en/download"
  read -n 1 -s -r -p "  Press any key to close this window."
  exit 1
fi

node server.js "$@"
