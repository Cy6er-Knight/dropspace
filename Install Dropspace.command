#!/bin/bash
# Install Dropspace on this Mac. Double-click this once.
#
# On your main Mac, Dropspace starts by itself when you log in and runs quietly in the
# background, with no Terminal window. Open it from Applications or your Dock.
# On any other Mac, this sets up sending to the main one instead.
# Either way you get "Send to Dropspace" when you right-click files in Finder, and
# Control-Option-Command-V to send whatever you copied, from any app.
# On another Mac it also sets up the secure connection: macOS asks for your password once to
# trust your main Mac's Dropspace certificate, so your browsers use https://dropspace.local.
#
# To update later, download the new version and double-click this again.

set -u
cd "$(dirname "$0")" || exit 1

LABEL="com.dropspace.server"
SUPPORT="$HOME/Library/Application Support/Dropspace"
APPCODE="$SUPPORT/app"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/Dropspace.log"
STATUS="$HOME/.dropspace/status.json"
CA="$HOME/.dropspace/ca.pem"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
SERVICES="$HOME/Library/Services"
GUI="gui/$(id -u)"

say() { printf '\n  %s\n' "$*"; }
finish() {
  echo
  read -n 1 -s -r -p "  Press any key to close this window."
  echo
  exit "$1"
}
fail() {
  say "$*"
  finish 1
}
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
# Text made safe to put inside an AppleScript "string".
as_text() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

clear
say "Setting up Dropspace…"

[ -f server.js ] && [ -f send.js ] && [ -d public ] && [ -f mac/Dropspace.icns ] ||
  fail "Some of Dropspace's files are missing. Unzip the whole download, then double-click Install Dropspace inside that folder."

# ---------------------------------------------------------------- Node.js
# Finder starts this without your usual shell setup, so look where Node usually lives.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  open "https://nodejs.org/en/download"
  fail "Dropspace needs Node.js, which is free. The download page is opening now.
  Install it (the LTS version), then double-click Install Dropspace again."
fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$MAJOR" -lt 18 ]; then
  open "https://nodejs.org/en/download"
  fail "Dropspace needs Node.js 18 or newer, and this Mac has $("$NODE" -v).
  Install the latest LTS version, then double-click Install Dropspace again."
fi

# ---------------------------------------------------------------- Shared pieces

copy_code() {
  mkdir -p "$SUPPORT" || fail "Couldn't create Dropspace's folder in your Library."
  rm -rf "$APPCODE.new"
  mkdir -p "$APPCODE.new"
  cp -R server.js send.js clipboard.js zip.js tls.js multipart.js shortcut.js package.json public "$APPCODE.new/" ||
    fail "Couldn't copy Dropspace's files."
  rm -rf "$APPCODE"
  mv "$APPCODE.new" "$APPCODE"
  xattr -dr com.apple.quarantine "$SUPPORT" 2>/dev/null
}

# A Quick Action (an Automator workflow) that runs one command.
#   $1 menu title   $2 "files" (Finder's right-click menu) or "none" (any app's Services menu)   $3 command
make_workflow() {
  local title="$1" input="$2" command="$3"
  local wf="$SERVICES/$title.workflow"
  local in_type="com.apple.Automator.nothing" method=0 send_types="" context="" app_meta=""
  if [ "$input" = "files" ]; then
    in_type="com.apple.Automator.fileSystemObject"
    method=1
    send_types="<key>NSSendFileTypes</key><array><string>public.item</string></array>"
    context="<key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>"
    app_meta="<key>serviceApplicationBundleID</key><string>com.apple.finder</string><key>serviceApplicationPath</key><string>/System/Library/CoreServices/Finder.app</string>"
  fi
  local u1 u2 u3
  u1="$(uuidgen)"
  u2="$(uuidgen)"
  u3="$(uuidgen)"
  rm -rf "$wf"
  mkdir -p "$wf/Contents"
  cat > "$wf/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSBackgroundColorName</key>
      <string>background</string>
      <key>NSIconName</key>
      <string>NSActionTemplate</string>
      <key>NSMenuItem</key>
      <dict>
        <key>default</key>
        <string>$(xml "$title")</string>
      </dict>
      <key>NSMessage</key>
      <string>runWorkflowAsService</string>
      $context
      $send_types
    </dict>
  </array>
</dict>
</plist>
PLIST
  cat > "$wf/Contents/document.wflow" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key>
  <string>523</string>
  <key>AMApplicationVersion</key>
  <string>2.10</string>
  <key>AMDocumentVersion</key>
  <string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Optional</key>
          <true/>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.string</string>
          </array>
        </dict>
        <key>AMActionVersion</key>
        <string>2.0.3</string>
        <key>AMApplication</key>
        <array>
          <string>Automator</string>
        </array>
        <key>AMParameterProperties</key>
        <dict>
          <key>COMMAND_STRING</key>
          <dict/>
          <key>CheckedForUserDefaultShell</key>
          <dict/>
          <key>inputMethod</key>
          <dict/>
          <key>shell</key>
          <dict/>
          <key>source</key>
          <dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.string</string>
          </array>
        </dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key>
        <string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key>
          <string>$(xml "$command")</string>
          <key>CheckedForUserDefaultShell</key>
          <true/>
          <key>inputMethod</key>
          <integer>$method</integer>
          <key>shell</key>
          <string>/bin/bash</string>
          <key>source</key>
          <string></string>
        </dict>
        <key>BundleIdentifier</key>
        <string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key>
        <string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key>
        <false/>
        <key>CanShowWhenRun</key>
        <true/>
        <key>Category</key>
        <array>
          <string>AMCategoryUtilities</string>
        </array>
        <key>Class Name</key>
        <string>RunShellScriptAction</string>
        <key>InputUUID</key>
        <string>$u1</string>
        <key>Keywords</key>
        <array>
          <string>Shell</string>
          <string>Script</string>
          <string>Command</string>
          <string>Run</string>
          <string>Unix</string>
        </array>
        <key>OutputUUID</key>
        <string>$u2</string>
        <key>UUID</key>
        <string>$u3</string>
        <key>UnlocalizedApplications</key>
        <array>
          <string>Automator</string>
        </array>
        <key>arguments</key>
        <dict>
          <key>0</key>
          <dict>
            <key>default value</key>
            <integer>0</integer>
            <key>name</key>
            <string>inputMethod</string>
            <key>required</key>
            <string>0</string>
            <key>type</key>
            <string>0</string>
            <key>uuid</key>
            <string>0</string>
          </dict>
          <key>1</key>
          <dict>
            <key>default value</key>
            <string></string>
            <key>name</key>
            <string>source</string>
            <key>required</key>
            <string>0</string>
            <key>type</key>
            <string>0</string>
            <key>uuid</key>
            <string>1</string>
          </dict>
          <key>2</key>
          <dict>
            <key>default value</key>
            <false/>
            <key>name</key>
            <string>CheckedForUserDefaultShell</string>
            <key>required</key>
            <string>0</string>
            <key>type</key>
            <string>0</string>
            <key>uuid</key>
            <string>2</string>
          </dict>
          <key>3</key>
          <dict>
            <key>default value</key>
            <string></string>
            <key>name</key>
            <string>COMMAND_STRING</string>
            <key>required</key>
            <string>0</string>
            <key>type</key>
            <string>0</string>
            <key>uuid</key>
            <string>3</string>
          </dict>
          <key>4</key>
          <dict>
            <key>default value</key>
            <string>/bin/sh</string>
            <key>name</key>
            <string>shell</string>
            <key>required</key>
            <string>0</string>
            <key>type</key>
            <string>0</string>
            <key>uuid</key>
            <string>4</string>
          </dict>
        </dict>
        <key>isViewVisible</key>
        <integer>1</integer>
        <key>location</key>
        <string>309.000000:253.000000</string>
        <key>nibPath</key>
        <string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
      </dict>
      <key>isViewVisible</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>connectors</key>
  <dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>applicationBundleIDsByPath</key>
    <dict/>
    <key>applicationPaths</key>
    <array/>
    <key>inputTypeIdentifier</key>
    <string>$in_type</string>
    <key>outputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>presentationMode</key>
    <integer>15</integer>
    <key>processesInput</key>
    <integer>0</integer>
    $app_meta
    <key>serviceInputTypeIdentifier</key>
    <string>$in_type</string>
    <key>serviceOutputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key>
    <integer>0</integer>
    <key>systemImageName</key>
    <string>NSActionTemplate</string>
    <key>useAutomaticInputType</key>
    <integer>0</integer>
    <key>workflowTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
PLIST
  plutil -lint "$wf/Contents/Info.plist" >/dev/null && plutil -lint "$wf/Contents/document.wflow" >/dev/null ||
    fail "Couldn't create the $title action."
}

# Finder's "Send to Dropspace", and "Send Clipboard to Dropspace" on Control-Option-Command-V.
install_shortcuts() {
  mkdir -p "$SERVICES"
  local send="\"$NODE\" \"$APPCODE/send.js\""
  make_workflow "Send to Dropspace" files "$send \"\$@\""
  make_workflow "Send Clipboard to Dropspace" none "$send --clipboard"
  defaults write pbs NSServicesStatus -dict-add '"(null) - Send to Dropspace - runWorkflowAsService"' \
    '{ "enabled_context_menu" = 1; "enabled_services_menu" = 1; "presentation_modes" = { ContextMenu = 1; ServicesMenu = 1; }; }' 2>/dev/null
  # @ is Command, ~ is Option, ^ is Control.
  defaults write pbs NSServicesStatus -dict-add '"(null) - Send Clipboard to Dropspace - runWorkflowAsService"' \
    '{ "key_equivalent" = "@~^v"; "enabled_context_menu" = 1; "enabled_services_menu" = 1; "presentation_modes" = { ContextMenu = 1; ServicesMenu = 1; }; }' 2>/dev/null
  /System/Library/CoreServices/pbs -flush >/dev/null 2>&1
  /System/Library/CoreServices/pbs -update >/dev/null 2>&1
}

# The secure connection on another Mac: trust the main Mac's certificate authority (saved when pairing).
# It can only vouch for local network names like dropspace.local, never for real websites.
SECURE=""
trust_certificate() {
  [ -f "$CA" ] || return 0
  if security verify-cert -c "$CA" >/dev/null 2>&1; then
    SECURE="yes"
    return 0
  fi
  local choice
  choice="$(osascript -e 'button returned of (display dialog "Last step: turn on the secure connection." & return & return & "Your Mac will ask for your password once, to trust Dropspace on your main Mac. Then your browser uses a secure connection to it, the Send Clipboard button works on this Mac too, and it is safe to use on school Wi-Fi." buttons {"Skip", "Continue"} default button "Continue" with title "Dropspace")' 2>/dev/null)"
  [ "$choice" = "Continue" ] || return 0
  if security add-trusted-cert -r trustRoot -k "$LOGIN_KEYCHAIN" "$CA" >/dev/null 2>&1; then
    SECURE="yes"
  else
    SECURE="no"
  fi
}

# ---------------------------------------------------------------- Main Mac, or another Mac?
MODE="main"
FOUND=""
HOST_NAME=""
LOCAL_PORT="$(sed -n 's/.*"port":[ ]*\([0-9]*\).*/\1/p' "$STATUS" 2>/dev/null)"
RUNNING_HERE=""
[ -n "$LOCAL_PORT" ] && curl -s -m 1 -o /dev/null "http://localhost:$LOCAL_PORT/api/whoami" && RUNNING_HERE="yes"
if [ ! -f "$AGENT" ] && [ -z "$RUNNING_HERE" ]; then
  for ADDR in "http://dropspace.local" "http://dropspace.local:8765"; do
    INFO="$(curl -s -m 3 "$ADDR/api/whoami" 2>/dev/null)"
    if printf '%s' "$INFO" | grep -q '"hostName"'; then
      FOUND="$ADDR"
      HOST_NAME="$(printf '%s' "$INFO" | sed -n 's/.*"hostName":"\([^"]*\)".*/\1/p')"
      break
    fi
  done
  if [ -n "$FOUND" ]; then
    CHOICE="$(osascript -e "button returned of (display dialog \"Dropspace is already running on $(as_text "${HOST_NAME:-another Mac}").\" & return & return & \"Set up this Mac to send to it? You'll get Send to Dropspace when you right-click files in Finder, and Control-Option-Command-V to send what you copied.\" buttons {\"Install Here Instead\", \"Set Up Sending\"} default button \"Set Up Sending\" with title \"Dropspace\")" 2>/dev/null)"
    [ "$CHOICE" = "Set Up Sending" ] && MODE="sender"
  fi
fi

# ---------------------------------------------------------------- Another Mac: send to the main one
if [ "$MODE" = "sender" ]; then
  copy_code
  PAIRED=""
  # Already paired from an earlier install? Then there's no code to type.
  DROPSPACE_NO_NOTIFY=1 "$NODE" "$APPCODE/send.js" --check >/dev/null 2>&1 && PAIRED="yes"
  for _ in 1 2 3; do
    [ -n "$PAIRED" ] && break
    PIN="$(osascript -e "text returned of (display dialog \"Enter the 6-digit code from Dropspace on $(as_text "${HOST_NAME:-your main Mac}").\" & return & return & \"To see it, open Dropspace on that Mac and click Add Device.\" default answer \"\" buttons {\"Cancel\", \"Pair\"} default button \"Pair\" with title \"Dropspace\")" 2>/dev/null)" ||
      fail "Setup was cancelled. Double-click Install Dropspace to try again."
    if OUT="$(DROPSPACE_NO_NOTIFY=1 "$NODE" "$APPCODE/send.js" --pair "$FOUND" "$PIN" 2>&1)"; then
      PAIRED="yes"
      break
    fi
    osascript -e "display alert \"That code didn't work\" message \"$(as_text "$OUT")\"" >/dev/null 2>&1
  done
  [ -n "$PAIRED" ] || fail "Pairing didn't work. Check the code on your main Mac, then double-click Install Dropspace again."
  install_shortcuts
  trust_certificate
  say "This Mac now sends to Dropspace on ${HOST_NAME:-your main Mac}."
  say "Right-click files in Finder, then choose Quick Actions, then Send to Dropspace."
  say "Press Control-Option-Command-V in any app to send whatever you copied."
  say "Both go into the folder you have open in Dropspace on this Mac."
  case "$SECURE" in
    yes) say "The secure connection is on. Open ${FOUND:-http://dropspace.local} in your browser and it switches to https by itself." ;;
    no) say "The secure connection wasn't turned on (the password step didn't finish). Double-click Install Dropspace again to retry." ;;
    *) [ -f "$CA" ] && say "You skipped the secure connection. Double-click Install Dropspace again any time to turn it on." ;;
  esac
  say "If the right-click option isn't there yet, log out and back in once."
  say "You can close this window."
  finish 0
fi

# ---------------------------------------------------------------- Main Mac: stop any copy that's already running
say "Installing Dropspace…"
launchctl bootout "$GUI/$LABEL" >/dev/null 2>&1
if [ -f "$STATUS" ]; then
  PID="$(sed -n 's/.*"pid":[ ]*\([0-9]*\).*/\1/p' "$STATUS")"
  if [ -n "$PID" ] && ps -p "$PID" -o command= 2>/dev/null | grep -q "server.js"; then
    kill "$PID" 2>/dev/null
    sleep 1
  fi
fi

# ---------------------------------------------------------------- Copy Dropspace somewhere permanent
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
copy_code

# ---------------------------------------------------------------- Start at login, in the background
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$APPCODE/server.js")</string>
    <string>--no-open</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml "$APPCODE")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DROPSPACE_SERVICE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$LOG")</string>
</dict>
</plist>
PLIST
plutil -lint "$AGENT" >/dev/null || fail "Couldn't set Dropspace to start at login."
launchctl bootstrap "$GUI" "$AGENT" 2>/dev/null || launchctl load -w "$AGENT" 2>/dev/null

# ---------------------------------------------------------------- The Dropspace app (for Applications and the Dock)
APPS="/Applications"
[ -w "$APPS" ] || { APPS="$HOME/Applications"; mkdir -p "$APPS"; }
APP="$APPS/Dropspace.app"
if [ -d "$APP" ] && ! grep -q "com.dropspace.launcher" "$APP/Contents/Info.plist" 2>/dev/null; then
  fail "There's already a different app called Dropspace in $APPS. Rename or remove it, then try again."
fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp mac/Dropspace.icns "$APP/Contents/Resources/Dropspace.icns"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json)"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Dropspace</string>
  <key>CFBundleDisplayName</key>
  <string>Dropspace</string>
  <key>CFBundleIdentifier</key>
  <string>com.dropspace.launcher</string>
  <key>CFBundleExecutable</key>
  <string>Dropspace</string>
  <key>CFBundleIconFile</key>
  <string>Dropspace</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION:-1.0}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION:-1.0}</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST
cat > "$APP/Contents/MacOS/Dropspace" <<'LAUNCHER'
#!/bin/bash
# Opens Dropspace in your browser, starting it first if it isn't running.
STATUS="$HOME/.dropspace/status.json"
running_port() {
  local p
  p="$(/usr/bin/sed -n 's/.*"port":[ ]*\([0-9]*\).*/\1/p' "$STATUS" 2>/dev/null)"
  [ -n "$p" ] && /usr/bin/curl -s -m 1 -o /dev/null "http://localhost:$p/api/whoami" && echo "$p"
}
PORT="$(running_port)"
if [ -z "$PORT" ]; then
  /bin/launchctl kickstart "gui/$(/usr/bin/id -u)/com.dropspace.server" >/dev/null 2>&1
  for _ in $(/usr/bin/seq 1 40); do
    /bin/sleep 0.25
    PORT="$(running_port)"
    [ -n "$PORT" ] && break
  done
fi
if [ -z "$PORT" ]; then
  /usr/bin/osascript -e 'display alert "Dropspace didn’t start" message "Open the Dropspace folder you downloaded and double-click Install Dropspace again."' >/dev/null
  exit 1
fi
if [ "$PORT" = "80" ]; then /usr/bin/open "http://localhost"; else /usr/bin/open "http://localhost:$PORT"; fi
LAUNCHER
chmod +x "$APP/Contents/MacOS/Dropspace"
plutil -lint "$APP/Contents/Info.plist" >/dev/null || fail "Couldn't create the Dropspace app."
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1

# ---------------------------------------------------------------- Right-click and clipboard shortcuts
install_shortcuts

# ---------------------------------------------------------------- Wait for it, then open it
STARTED=""
for _ in $(seq 1 40); do
  sleep 0.25
  P="$(sed -n 's/.*"port":[ ]*\([0-9]*\).*/\1/p' "$STATUS" 2>/dev/null)"
  if [ -n "$P" ] && curl -s -m 1 -o /dev/null "http://localhost:$P/api/whoami"; then
    STARTED="yes"
    break
  fi
done
[ -n "$STARTED" ] || fail "Dropspace was installed but didn't start. The details are in ~/Library/Logs/Dropspace.log."

open "$APP"

say "Dropspace is installed."
say "It starts by itself when you log in, so there's nothing to keep open."
say "Open it any time from Applications, or drag Dropspace from Applications into your Dock."
say "Right-click files in Finder, then choose Quick Actions, then Send to Dropspace."
say "Press Control-Option-Command-V in any app to send whatever you copied."
say "If your Mac asks to let \"node\" access your Downloads folder or accept connections, click Allow."
say "To send from another Mac too, double-click Install Dropspace on that Mac."
say "You can close this window."
finish 0
