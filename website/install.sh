#!/bin/zsh

# =============================================================================
#  InHand — STUDENT CLIENT installer (macOS)
#
#  IMPORTANT: install.sh is for the STUDENT CLIENT ONLY.
#             Do NOT run this script on the teacher's (host) machine.
#
#  Security notes:
#    - Installs into ~/Library/Application Support/InHand (no sudo,
#      no world-writable directory).
#    - Auto-start uses a per-user LaunchAgent (no root privileges needed).
#    - Optional LAN-only firewall helper (flag -f): installs ONE tiny root
#      daemon + pf anchor via a single sudo prompt. See README.
#    - The Screen Recording permission is required so the teacher can view
#      this screen; the installer walks you through granting it.
# =============================================================================

# --- Defaults ---
API_URL="https://inhand-server.vercel.app"
MODE="install"
URL_SPECIFIED=false
IS_UPDATE=false
FIREWALL=false

INSTALL_DIR="$HOME/Library/Application Support/InHand"
APP_NAME="InHand Student.app"
APP_PATH="$INSTALL_DIR/$APP_NAME"
APP_EXECUTABLE="$APP_PATH/Contents/MacOS/InHand Student"
AGENT_LABEL="com.inhand.student"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
DMG_URL="https://github.com/ChuTM/inhand/releases/latest/download/InHand-arm64.dmg"
FW_HELPER_BASE="https://ihinstall.web.app/firewall"

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
    *)
      echo "[ERROR] Unknown option: $1"
      echo "Usage: bash install.sh [-a https://your-api-server] [-f] [-u] [-v]"
      echo "       -a/--api-url : set the cloud API base URL (default https://inhand-server.vercel.app)"
      echo "       -f           : also install the LAN-only firewall helper (asks for admin once)"
      echo "       -u           : uninstall the student client"
      echo "       -v           : update the student client"
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
# Downloads the helper from the website and installs it as a root LaunchDaemon
# with a single sudo prompt. See README for usage + manual force-close.
install_firewall_helper() {
  local TMP_FW="$TMPDIR/inhand-fw-helper"
  mkdir -p "$TMP_FW"
  echo "[INFO] Downloading firewall helper from $FW_HELPER_BASE ..."
  curl -fsSL -o "$TMP_FW/daemon.mjs" "$FW_HELPER_BASE/daemon.mjs" || { echo "[ERROR] Failed to download daemon.mjs"; return 1; }
  curl -fsSL -o "$TMP_FW/inhand-fwctl" "$FW_HELPER_BASE/inhand-fwctl" || { echo "[ERROR] Failed to download inhand-fwctl"; return 1; }
  curl -fsSL -o "$TMP_FW/com.inhand.fw.plist" "$FW_HELPER_BASE/com.inhand.fw.plist" || { echo "[ERROR] Failed to download plist"; return 1; }

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
      /bin/launchctl bootout system/com.inhand.fw 2>/dev/null || true
      /bin/launchctl bootstrap system /Library/LaunchDaemons/com.inhand.fw.plist
      # Declare the pf anchor in /etc/pf.conf so the LAN-only rules actually
      # filter traffic (idempotent; the daemon also re-checks on every lock).
      "$FW_DIR/inhand-fwctl" ensure-anchor || echo "[WARN] Could not declare pf anchor in /etc/pf.conf"
      echo "[OK] Firewall helper installed (root daemon com.inhand.fw)."
    ' _ "$TMP_FW/daemon.mjs" "$TMP_FW/inhand-fwctl" "$APP_EXECUTABLE" "$TMP_FW/com.inhand.fw.plist"

  rm -rf "$TMP_FW"
  echo "[INFO] LAN-only mode is now available from the teacher's admin panel"
  echo "      (command: lan-only). Teacher key syncs automatically on discovery."
  echo "      Manual force-close: sudo inhand-fwctl unlock  (see README)."
}

uninstall_firewall_helper() {
  local WGFW="/Library/Application Support/InHand/inhand-fwctl"
  if [ -x "$WGFW" ]; then
    echo "[INFO] Removing LAN-only firewall helper (asks for admin ONCE)..."
    sudo "$WGFW" uninstall
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

# --- UPDATE MODE ---
if [ "$MODE" = "update" ]; then
  echo "[INFO] Starting application update sequence..."
  IS_UPDATE=true
  kill_app
  unload_agent
  MODE="install"
fi

# --- INSTALL MODE ---
if [ "$MODE" = "install" ]; then
  require_sudo
  mkdir -p "$INSTALL_DIR"

  echo "[INFO] Downloading InHand..."
  curl -fsSL -O "$DMG_URL" || { echo "[ERROR] Download failed."; exit 1; }
  ATTACH_OUT="$(hdiutil attach InHand-arm64.dmg 2>/dev/null)"
  VOLUME="$(printf '%s\n' "$ATTACH_OUT" | grep -oE '/Volumes/.*' | tail -1 | sed 's/[[:space:]]*$//')"
  if [ -z "$VOLUME" ] || [ ! -d "$VOLUME" ]; then
    echo "[ERROR] Could not locate the mounted InHand volume."
    exit 1
  fi
  echo "[INFO] Mounted at: $VOLUME"

  echo "[INFO] Copying service files (user-level, no sudo)..."
  APP_SRC="$(find "$VOLUME" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null)"
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

  # Start the app once so macOS registers it for Screen Recording permission
  open "$APP_PATH"

  # --- SCREEN RECORDING PERMISSION (required for the teacher to view this screen) ---
  echo ""
  echo "[INFO] Please grant the following macOS permission when prompted:"
  echo "       1. Screen Recording (required so the teacher can view this screen)"
  echo ""
  echo "[INFO] Opening System Settings -> Privacy & Security -> Screen Recording..."
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  echo "       In the list, enable \"InHand Student\"."
  echo "       (If it is not listed yet, wait a moment for the app to register, then reopen the pane.)"
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
    echo "       and enable \"InHand Student\", then restart the app."
  else
    echo "[INFO] Screen capture check passed."
  fi

  echo "[INFO] Cleaning up installer files..."
  hdiutil detach "$VOLUME" 2>/dev/null
  rm -f InHand-arm64.dmg

  install_launch_agent

  # Optional: LAN-only firewall helper (single sudo prompt)
  if [ "$FIREWALL" = true ]; then
    install_firewall_helper
  fi

  echo ""
  echo "[SUCCESS] InHand STUDENT CLIENT is now installed and active."
  echo "          Install directory: $INSTALL_DIR"
  echo "          Auto-start: LaunchAgent ($AGENT_LABEL) — no root needed."
  if [ "$FIREWALL" = true ]; then
    echo "          LAN-only firewall helper: installed (root daemon com.inhand.fw)."
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
  uninstall_firewall_helper
  echo "[SUCCESS] InHand student client uninstalled."
fi
