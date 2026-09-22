#!/bin/zsh

# =============================================================================
#  InHand — STUDENT CLIENT installer / updater (macOS)
#
#  IMPORTANT: install.sh is for the STUDENT CLIENT ONLY.
#             Do NOT run this script on the teacher's (host) machine.
#
#  Components on a student machine:
#    - Main app   (InHand Student.app, user dir)     — UI-less, updates often
#    - Capture    (InHand Capture.app, /Library)     — screen capture helper,
#                                                      holds the Screen Recording
#                                                      grant; updates rarely
#    - Firewall   (com.inhand.fw daemon, /Library)   — LAN-only helper, root;
#                                                      updates rarely
#
#  UPDATE POLICY (important):
#    The default `-v/--update` only replaces the MAIN APP, so the Capture and
#    Firewall helpers (and their one-time macOS permissions) are NEVER touched.
#    Use --scope to opt into updating helpers explicitly:
#      --scope=fw           only the firewall helper
#      --scope=capture      only the capture helper
#      --scope=fw-capture   capture + firewall
#      --scope=all          everything (main app + capture + firewall)
#
#  Security notes:
#    - Main app installs into ~/Library/Application Support/InHand (no sudo).
#    - Capture + Firewall live under /Library/Application Support/InHand,
#      owned by root, so a student cannot remove them.
#    - Auto-start uses a per-user LaunchAgent (no root privileges needed).
#    - The LAN-only firewall helper (flag -f / scope fw): installs ONE tiny
#      root daemon + pf anchor via a single sudo prompt. See README.
#    - The Screen Recording permission is granted ONCE to the Capture helper;
#      the installer walks you through it on first install only.
# =============================================================================

# --- Defaults ---
API_URL="https://inhand-server.vercel.app"
MODE="install"
URL_SPECIFIED=false
IS_UPDATE=false
FIREWALL=false
SCOPE="app"

INSTALL_DIR="$HOME/Library/Application Support/InHand"
APP_NAME="InHand Student.app"
APP_PATH="$INSTALL_DIR/$APP_NAME"
APP_EXECUTABLE="$APP_PATH/Contents/MacOS/InHand Student"
AGENT_LABEL="com.inhand.student"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
DMG_URL="https://github.com/ChuTM/inhand/releases/latest/download/InHand-arm64.dmg"
FW_HELPER_BASE="https://ihinstall.web.app/firewall"
CAPTURE_DIR="/Library/Application Support/InHand"
CAPTURE_APP_NAME="InHand Capture.app"
CAPTURE_APP_PATH="$CAPTURE_DIR/$CAPTURE_APP_NAME"
CAPTURE_DMG_URL="https://github.com/ChuTM/inhand/releases/latest/download/InHand-Capture-arm64.dmg"
INSTALL_HINT_CAPTURE='sudo curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- --scope=capture'

usage() {
  cat <<'EOF'
Usage: bash install.sh [options]

  -a, --api-url <url>   set the cloud API base URL
                        (default https://inhand-server.vercel.app)
  -f, --firewall        also install/update the LAN-only firewall helper
  -u, --uninstall       uninstall the student client (app + capture + firewall)
  -v, --update          update the client

Update scope (with -v). DEFAULT = main app only, helpers are never touched:
      --scope=fw           only the firewall helper
      --scope=capture      only the capture helper
      --scope=fw-capture   capture + firewall
      --scope=all          everything (main app + capture + firewall)

Examples:
  bash install.sh                    first-time install (main app)
  bash install.sh -f                 first-time install + firewall helper
  bash install.sh -v                 update main app only  (safe default)
  bash install.sh -v --scope=fw          update firewall helper only
  bash install.sh -v --scope=capture     update capture helper only
  bash install.sh -v --scope=fw-capture  update capture + firewall
  bash install.sh -v --scope=all         update everything
EOF
}

# --- Parse Flags ---
while [[ $# -gt 0 ]]; do
  case $1 in
    -a|--api-url)
      API_URL="$2"
      URL_SPECIFIED=true
      shift 2
      ;;
    -f|--firewall)
      FIREWALL=true
      shift
      ;;
    -u|--uninstall)
      MODE="uninstall"
      shift
      ;;
    -v|--update)
      MODE="update"
      shift
      ;;
    --scope=*)
      SCOPE="${1#--scope=}"
      shift
      ;;
    --scope)
      SCOPE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

# --- Apple Silicon Check (install and update only) ---
if [ "$MODE" = "install" ] || [ "$MODE" = "update" ]; then
  ARCH=$(uname -m)
  if [ "$ARCH" != "arm64" ]; then
    echo "[ERROR] This installer only supports Apple Silicon (arm64)."
    exit 1
  fi
fi

# --- Require sudo (administrator privileges) ---
# The installer must refuse to run on machines without working sudo.
require_sudo() {
  if ! command -v sudo >/dev/null 2>&1; then
    echo "[ERROR] sudo is not available on this system."
    echo "       This installer requires an administrator (sudo) account."
    exit 1
  fi
  if ! sudo -v 2>/dev/null; then
    echo "[ERROR] sudo is not configured for this account."
    echo "       This installer refuses to continue without sudo."
    echo "       Log in as an administrator (or enable sudo for this user) and retry."
    exit 1
  fi
  echo "[INFO] sudo OK - administrator privileges confirmed."
}

# --- Helper Functions ---
kill_app() {
  pkill -9 -f "InHand Student" 2>/dev/null
}

kill_capture() {
  pkill -9 -f "InHand Capture" 2>/dev/null
}

unload_agent() {
  launchctl bootout "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null
  launchctl unload -w "$AGENT_PLIST" 2>/dev/null
  rm -f "$AGENT_PLIST"
}

kill_and_clean_app() {
  echo "[INFO] Stopping and removing the current InHand student client..."
  kill_app
  unload_agent
  rm -rf "$INSTALL_DIR"
}

install_launch_agent() {
  echo "[INFO] Registering per-user LaunchAgent (no root required)..."
  cat > "$AGENT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$AGENT_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$APP_EXECUTABLE</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF
  chmod 644 "$AGENT_PLIST"
  # Modern launchd API first, legacy fallback for older macOS
  launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST" 2>/dev/null \
    || launchctl load -w "$AGENT_PLIST"
}

# --- LAN-ONLY FIREWALL HELPER (optional, one-time admin) ---
# Prefers the helper bundled inside the app bundle (always in sync with the
# app version). Falls back to the website only for old app builds that
# predate bundling. Installs it as a root LaunchDaemon with one sudo prompt.
install_firewall_helper() {
  local TMP_FW="$TMPDIR/inhand-fw-helper"
  local BUNDLED="$APP_PATH/Contents/Resources/helpers"
  mkdir -p "$TMP_FW"
  if [ -f "$BUNDLED/daemon.mjs" ] && [ -f "$BUNDLED/inhand-fwctl" ] && [ -f "$BUNDLED/com.inhand.fw.plist" ]; then
    echo "[INFO] Using firewall helper bundled inside the app..."
    cp "$BUNDLED/daemon.mjs" "$BUNDLED/inhand-fwctl" "$BUNDLED/com.inhand.fw.plist" "$TMP_FW/" \
      || { echo "[ERROR] Failed to copy bundled helper files"; rm -rf "$TMP_FW"; return 1; }
  else
    echo "[INFO] No bundled helper in this app build — downloading from $FW_HELPER_BASE ..."
    curl -fsSL -o "$TMP_FW/daemon.mjs" "$FW_HELPER_BASE/daemon.mjs" || { echo "[ERROR] Failed to download daemon.mjs"; rm -rf "$TMP_FW"; return 1; }
    curl -fsSL -o "$TMP_FW/inhand-fwctl" "$FW_HELPER_BASE/inhand-fwctl" || { echo "[ERROR] Failed to download inhand-fwctl"; rm -rf "$TMP_FW"; return 1; }
    curl -fsSL -o "$TMP_FW/com.inhand.fw.plist" "$FW_HELPER_BASE/com.inhand.fw.plist" || { echo "[ERROR] Failed to download plist"; rm -rf "$TMP_FW"; return 1; }
  fi

  echo "[INFO] Installing firewall helper (asks for admin ONCE)..."
  sudo -p "Password for admin (needed to install the LAN-only firewall helper): " \
    /bin/zsh -c '
      set -e
      FW_DIR="/Library/Application Support/InHand"
      mkdir -p "$FW_DIR" && chmod 755 "$FW_DIR"
      cp "$1" "$FW_DIR/daemon.mjs" && chmod 600 "$FW_DIR/daemon.mjs"
      cp "$2" "$FW_DIR/inhand-fwctl" && chmod 755 "$FW_DIR/inhand-fwctl"
      sed "s|__APP_EXECUTABLE__|$3|g" "$4" > /Library/LaunchDaemons/com.inhand.fw.plist
      chmod 644 /Library/LaunchDaemons/com.inhand.fw.plist
      # Idempotent (re)load: a previous daemon may already be loaded.
      /bin/launchctl bootout system/com.inhand.fw 2>/dev/null || true
      sleep 1
      /bin/launchctl bootstrap system /Library/LaunchDaemons/com.inhand.fw.plist
      /bin/launchctl kickstart -k system/com.inhand.fw
      # Declare the pf anchor in /etc/pf.conf so the LAN-only rules actually
      # filter traffic (idempotent; the daemon also re-checks on every lock).
      "$FW_DIR/inhand-fwctl" ensure-anchor || echo "[WARN] Could not declare pf anchor in /etc/pf.conf"
      echo "[OK] Firewall helper installed (root daemon com.inhand.fw)."
    ' _ "$TMP_FW/daemon.mjs" "$TMP_FW/inhand-fwctl" "$APP_EXECUTABLE" "$TMP_FW/com.inhand.fw.plist" \
    || { echo "[ERROR] Firewall helper install failed (see message above)."; rm -rf "$TMP_FW"; return 1; }

  rm -rf "$TMP_FW"
  echo "[INFO] LAN-only mode is now available from the teacher's admin panel"
  echo "      (command: lan-only). Teacher key syncs automatically on discovery."
  echo "      Manual force-close: sudo sh /Library/Application Support/InHand/inhand-fwctl unlock  (see README)."
}

uninstall_firewall_helper() {
  local WGFW="/Library/Application Support/InHand/inhand-fwctl"
  if [ -x "$WGFW" ]; then
    echo "[INFO] Removing LAN-only firewall helper (asks for admin ONCE)..."
    sudo "$WGFW" uninstall
  fi
}

# --- CAPTURE HELPER (screen capture, root-owned, holds the TCC grant) ---
# Installed/updated ONLY via --scope=capture|fw-capture|all. Updating the main
# app NEVER touches it, so the one-time Screen Recording grant stays valid.
install_capture_helper() {
  echo "[INFO] Installing/updating Capture helper (root-owned, $CAPTURE_APP_PATH)..."
  require_sudo
  local TMP="$TMPDIR/inhand-capture-install"
  mkdir -p "$TMP"
  local CAPTURE_DMG="$TMP/Capture-arm64.dmg"
  curl -fsSL -o "$CAPTURE_DMG" "$CAPTURE_DMG_URL" || {
    echo "[ERROR] Capture download failed: $CAPTURE_DMG_URL"
    rm -rf "$TMP"
    return 1
  }
  local ATTACH_OUT; ATTACH_OUT="$(hdiutil attach "$CAPTURE_DMG" -nobrowse 2>&1)"
  local VOLUME; VOLUME="$(printf '%s\n' "$ATTACH_OUT" | grep -oE '/Volumes/[^[:space:]].*' | tail -1 | sed 's/[[:space:]]*$//')"
  if [ -z "$VOLUME" ] || [ ! -d "$VOLUME" ]; then
    echo "[ERROR] Could not mount Capture disk image."
    rm -rf "$TMP"
    return 1
  fi
  local APP_SRC; APP_SRC="$(find "$VOLUME" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null)"
  if [ -z "$APP_SRC" ] || [ ! -d "$APP_SRC" ]; then
    echo "[ERROR] InHand Capture.app not found in the mounted volume."
    hdiutil detach "$VOLUME" 2>/dev/null
    rm -rf "$TMP"
    return 1
  fi
  kill_capture
  sudo /bin/zsh -c '
    set -e
    CAP_DIR="/Library/Application Support/InHand"
    mkdir -p "$CAP_DIR" && chmod 755 "$CAP_DIR"
    rm -rf "$CAP_DIR/InHand Capture.app"
    cp -R "$1" "$CAP_DIR/InHand Capture.app"
    chmod -R 755 "$CAP_DIR/InHand Capture.app"
    xattr -dr com.apple.quarantine "$CAP_DIR/InHand Capture.app" 2>/dev/null || true
    echo "[OK] Capture helper installed at $CAP_DIR/InHand Capture.app"
  ' _ "$APP_SRC" || { hdiutil detach "$VOLUME" 2>/dev/null; rm -rf "$TMP"; return 1; }
  hdiutil detach "$VOLUME" 2>/dev/null
  rm -rf "$TMP"
  echo "[INFO] Capture helper updated. If this is the FIRST install, grant Screen"
  echo "      Recording to \"InHand Capture\" in System Settings once."
}

uninstall_capture_helper() {
  if [ -d "$CAPTURE_APP_PATH" ]; then
    echo "[INFO] Removing Capture helper (asks for admin ONCE)..."
    kill_capture
    sudo rm -rf "$CAPTURE_APP_PATH"
  fi
}

# --- Persist the cloud API URL ---
write_api_url() {
  local PROFILE="$HOME/.zshrc"
  [ -f "$PROFILE" ] || PROFILE="$HOME/.bash_profile"
  if grep -qE '^export WP_API_URL=' "$PROFILE" 2>/dev/null; then
    if [ "$URL_SPECIFIED" = true ]; then
      sed -i '' "s|export WP_API_URL=.*|export WP_API_URL=\"$API_URL\"|g" "$PROFILE"
      echo "[INFO] Updated WP_API_URL in $PROFILE to $API_URL"
    else
      echo "[INFO] WP_API_URL already defined in $PROFILE. Keeping it."
    fi
  else
    echo "export WP_API_URL=\"$API_URL\"" >> "$PROFILE"
    echo "[INFO] Wrote WP_API_URL to $PROFILE"
  fi
}

# --- DOWNLOAD & REPLACE MAIN APP (user-level, no sudo) ---
# Used by both first-time install and app-only update. Never touches the
# Capture/Firewall helpers and never re-prompts for Screen Recording.
install_main_app() {
  require_sudo
  mkdir -p "$INSTALL_DIR"

  echo "[INFO] Downloading InHand..."
  local INSTALL_TMP; INSTALL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/inhand-install.XXXXXX")"
  local DMG_FILE="$INSTALL_TMP/InHand-arm64.dmg"
  curl -fsSL -o "$DMG_FILE" "$DMG_URL" || {
    echo "[ERROR] Download failed: $DMG_URL"
    rm -rf "$INSTALL_TMP"
    exit 1
  }
  local ATTACH_OUT; ATTACH_OUT="$(hdiutil attach "$DMG_FILE" -nobrowse 2>&1)"
  local ATTACH_RC=$?
  if [ $ATTACH_RC -ne 0 ]; then
    echo "[ERROR] Failed to mount the disk image. hdiutil said:"
    printf '%s\n' "$ATTACH_OUT" | sed 's/^/       /'
    rm -rf "$INSTALL_TMP"
    exit 1
  fi
  local VOLUME; VOLUME="$(printf '%s\n' "$ATTACH_OUT" | grep -oE '/Volumes/[^[:space:]].*' | tail -1 | sed 's/[[:space:]]*$//')"
  if [ -z "$VOLUME" ] || [ ! -d "$VOLUME" ]; then
    echo "[ERROR] Could not locate the mounted InHand volume."
    echo "       hdiutil output was:"
    printf '%s\n' "$ATTACH_OUT" | sed 's/^/       /'
    rm -rf "$INSTALL_TMP"
    exit 1
  fi
  echo "[INFO] Mounted at: $VOLUME"

  echo "[INFO] Copying service files (user-level, no sudo)..."
  local APP_SRC; APP_SRC="$(find "$VOLUME" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null)"
  if [ -z "$APP_SRC" ] || [ ! -d "$APP_SRC" ]; then
    echo "[ERROR] InHand Student.app not found in the mounted volume."
    hdiutil detach "$VOLUME" 2>/dev/null
    exit 1
  fi
  cp -R "$APP_SRC" "$APP_PATH" \
    && xattr -rd com.apple.quarantine "$APP_PATH" 2>/dev/null
  [ -d "$APP_PATH" ] || { echo "[ERROR] Failed to copy the app into $INSTALL_DIR."; exit 1; }

  echo "[INFO] Verifying application signature..."
  codesign --verify --deep --strict "$APP_PATH" && echo "       codesign OK" \
    || echo "[WARN] codesign verification failed — is the app properly signed?"

  # Configure cloud API endpoint
  if [ "$URL_SPECIFIED" = true ] || [ -n "$API_URL" ]; then
    write_api_url
  fi

  echo "[INFO] Cleaning up installer files..."
  hdiutil detach "$VOLUME" 2>/dev/null
  rm -rf "$INSTALL_TMP"

  install_launch_agent
}

# --- UPDATE MODE ---
# Default scope is "app": only the main app is replaced; Capture and Firewall
# helpers (and their one-time permissions) are left untouched. Opt into helper
# updates with --scope=fw|capture|fw-capture|all.
if [ "$MODE" = "update" ]; then
  case "$SCOPE" in
    app|fw|capture|fw-capture|all) : ;;
    *)
      echo "[ERROR] Unknown --scope=$SCOPE (expected: app, fw, capture, fw-capture, all)"
      exit 1
      ;;
  esac
  echo "[INFO] Update scope: $SCOPE"

  # --- Main app only (default) ---
  if [ "$SCOPE" = "app" ] || [ "$SCOPE" = "all" ]; then
    echo "[INFO] Updating main app only — Capture & Firewall helpers untouched..."
    IS_UPDATE=true
    kill_app
    unload_agent
    install_main_app
    echo "[INFO] Restarting the app..."
    open "$APP_PATH"
  fi

  # --- Firewall helper only ---
  if [ "$SCOPE" = "fw" ] || [ "$SCOPE" = "fw-capture" ] || [ "$SCOPE" = "all" ]; then
    echo "[INFO] Updating firewall helper (root daemon)..."
    install_firewall_helper || { echo "[ERROR] Firewall helper update failed"; exit 1; }
  fi

  # --- Capture helper only ---
  if [ "$SCOPE" = "capture" ] || [ "$SCOPE" = "fw-capture" ] || [ "$SCOPE" = "all" ]; then
    echo "[INFO] Updating capture helper (root-owned)..."
    install_capture_helper || { echo "[ERROR] Capture helper update failed"; exit 1; }
  fi

  echo ""
  echo "[SUCCESS] InHand update complete (scope: $SCOPE)."
  exit 0
fi

# --- INSTALL MODE (first-time) ---
if [ "$MODE" = "install" ]; then
  install_main_app

  # --- Capture helper (root-owned, holds the Screen Recording grant) ---
  # Installed on first install so the main app has a capture source. Root-owned
  # under /Library so students cannot remove it; the one-time grant survives all
  # main-app updates. Falls back gracefully if it cannot be installed.
  CAPTURE_FAILED=false
  echo ""
  echo "[INFO] Installing Capture helper (root-owned, single admin prompt)..."
  if install_capture_helper; then
    echo "[INFO] Capture helper installed at $CAPTURE_APP_PATH"
  else
    CAPTURE_FAILED=true
    echo "[WARN] Capture helper failed to install — screen sharing will not work until"
    echo "       it is installed. Retry with: $INSTALL_HINT_CAPTURE"
  fi

  # Start the app once so macOS registers it
  open "$APP_PATH"

  # --- SCREEN RECORDING PERMISSION (required for the teacher to view this screen) ---
  # On first install only. The grant goes to the Capture helper ("InHand Capture"),
  # which is root-owned and updated almost never, so updates never reset it.
  echo ""
  echo "[INFO] Please grant the following macOS permission when prompted:"
  echo "       1. Screen Recording (required so the teacher can view this screen)"
  echo ""
  echo "[INFO] Opening System Settings -> Privacy & Security -> Screen Recording..."
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  echo "       In the list, enable \"InHand Capture\"."
  echo "       (If it is not listed yet, wait a moment for it to register, then reopen the pane.)"
  echo ""
  echo "Press ENTER once the permission is granted to continue..."

  (
    while true; do
      for c in "|" "/" "-" "\\"; do
        printf "\r[WAIT] Waiting for confirmation... %s" "$c"
        sleep 0.2
      done
    done
  ) &
  SPINNER_PID=$!

  read
  kill "$SPINNER_PID" 2>/dev/null
  wait "$SPINNER_PID" 2>/dev/null

  # Screen Recording grants only take effect after the app restarts
  echo "[INFO] Restarting the app so the Screen Recording permission applies..."
  kill_app
  sleep 1
  open "$APP_PATH"

  # Optional heuristic check: a screen capture with no permission is black/tiny
  /usr/sbin/screencapture -x /tmp/wg-perm-check.png 2>/dev/null
  SIZE=$(stat -f%z /tmp/wg-perm-check.png 2>/dev/null || echo 0)
  rm -f /tmp/wg-perm-check.png
  if [ "$SIZE" -lt 10000 ] 2>/dev/null; then
    echo "[WARN] Screen capture looks empty. Screen Recording may still be disabled."
    echo "       Reopen System Settings -> Privacy & Security -> Screen Recording"
    echo "       and enable \"InHand Capture\", then restart the app."
  else
    echo "[INFO] Screen capture check passed."
  fi

  # Optional: LAN-only firewall helper (single sudo prompt)
  if [ "$FIREWALL" = true ]; then
    install_firewall_helper || FW_FAILED=true
  fi

  echo ""
  echo "[SUCCESS] InHand STUDENT CLIENT is now installed and active."
  echo "          Install directory: $INSTALL_DIR"
  echo "          Auto-start: LaunchAgent ($AGENT_LABEL) — no root needed."
  if [ "$CAPTURE_FAILED" = true ]; then
    echo "          Capture helper: FAILED to install — rerun with --scope=capture,"
    echo "          or check the error above. Screen sharing will not work until fixed."
  else
    echo "          Capture helper: installed (root-owned InHand Capture.app)."
  fi
  if [ "$FIREWALL" = true ]; then
    if [ "$FW_FAILED" = true ]; then
      echo "          LAN-only firewall helper: FAILED to install — rerun with -f,"
      echo "          or check the error above. LAN-only will not work until fixed."
    else
      echo "          LAN-only firewall helper: installed (root daemon com.inhand.fw)."
    fi
  else
    echo "          LAN-only firewall helper: NOT installed (add -f to install it)."
  fi
  echo ""
  echo "NOTE: install.sh is for the STUDENT CLIENT only. If you are setting up the"
  echo "      teacher's machine, use the separate admin app instead."
fi

# --- UNINSTALL MODE ---
if [ "$MODE" = "uninstall" ]; then
  require_sudo
  kill_and_clean_app
  uninstall_capture_helper
  uninstall_firewall_helper
  echo "[SUCCESS] InHand student client uninstalled."
fi
