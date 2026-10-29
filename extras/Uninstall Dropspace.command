#!/bin/bash
# Removes Dropspace from this Mac: stops it, stops it starting at login, and removes the app,
# the right-click action and the clipboard shortcut.
# Your received files (~/Downloads/Dropspace) and your folders and settings (~/.dropspace) are kept.

LABEL="com.dropspace.server"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
for APP in "/Applications/Dropspace.app" "$HOME/Applications/Dropspace.app"; do
  if [ -d "$APP" ] && grep -q "com.dropspace.launcher" "$APP/Contents/Info.plist" 2>/dev/null; then
    rm -rf "$APP"
  fi
done
rm -rf "$HOME/Library/Services/Send to Dropspace.workflow" "$HOME/Library/Services/Send Clipboard to Dropspace.workflow"
/System/Library/CoreServices/pbs -flush >/dev/null 2>&1
rm -rf "$HOME/Library/Application Support/Dropspace"
# On a Mac that sent to another one: stop trusting that Mac's Dropspace certificate.
CA="$HOME/.dropspace/ca.pem"
if [ -f "$CA" ]; then
  security remove-trusted-cert "$CA" >/dev/null 2>&1
  SHA1="$(openssl x509 -in "$CA" -noout -fingerprint -sha1 2>/dev/null | sed 's/.*=//; s/://g')"
  [ -n "$SHA1" ] && security delete-certificate -Z "$SHA1" "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1
  rm -f "$CA"
fi
rm -f "$HOME/.dropspace/status.json" "$HOME/.dropspace/sender.json"

printf '\n  Dropspace is removed.\n'
printf '\n  Your files in Downloads › Dropspace, and your folders and settings, were kept.\n'
printf '  To remove those too, delete the Dropspace folder in Downloads and the hidden .dropspace folder in your home folder.\n\n'
read -n 1 -s -r -p "  Press any key to close this window."
echo
