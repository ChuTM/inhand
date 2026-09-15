#!/bin/zsh

# =============================================================================
#  Wallpaper Guard — STUDENT CLIENT installer (macOS, Apple Silicon)
#
#  IMPORTANT: This installer is for the STUDENT CLIENT ONLY.
#             Teachers (host side) should NOT run this script on their machine.
# =============================================================================

# --- Defaults ---
CONFIG_URL="https://wallpg.web.app/init_config.json"
MODE="install"
URL_SPECIFIED=false
IS_UPDATE=false

# --- Parse Flags ---
while [[ $# -gt 0 ]]; do
  case $1 in
    -c|--config)
      CONFIG_URL="$2"
      URL_SPECIFIED=true
      shift 2
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
      echo "Usage: bash install.sh [-c https://config.json] [-u] [-v]"
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

# --- Helper Functions for Reuse ---
kill_and_clean_app() {
  echo "[INFO] Stopping and removing current Wallpaper Guard service..."
  sudo lsof +D "/Library/Application Support/.sys_service" | awk 'NR>1 {print $2}' | xargs -r sudo kill -9 2>/dev/null
  sudo pkill -9 -f "System Wallpaper Service" 2>/dev/null
  sudo chflags -R noschg,nouchg "/Library/Application Support/.sys_service" 2>/dev/null
  sudo rm -rf "/Library/Application Support/.sys_service"
  
  sudo launchctl unload -w /Library/LaunchDaemons/com.system.wallpaper.service.plist 2>/dev/null
  sudo rm -f /Library/LaunchDaemons/com.system.wallpaper.service.plist
}

# --- UPDATE MODE INTERNAL ROUTING ---
if [ "$MODE" = "update" ]; then
  echo "[INFO] Starting application update sequence..."
  IS_UPDATE=true
  
  # Step 1: Detect existing config configuration to maintain persistent settings
  if [ "$URL_SPECIFIED" = false ]; then
    if [ -f ~/.zshrc ]; then
      # Extract the exact string inside the quotes if WP_CONFIG_URL exists
      EXISTING_URL=$(grep -E '^export WP_CONFIG_URL=' ~/.zshrc | tail -n 1 | sed -E 's/.*="([^"]*)".*/\1/')
      if [ -n "$EXISTING_URL" ]; then
        CONFIG_URL="$EXISTING_URL"
        echo "[INFO] Found existing configuration in ~/.zshrc. Preserving: $CONFIG_URL"
      fi
    fi
  fi

  # Step 2: Clear old running application artifacts to unlock systemic binary locks
  kill_and_clean_app
  
  # Step 3: Shift engine runtime straight over into the main install pipeline
  MODE="install"
fi

# --- INSTALL MODE ---
if [ "$MODE" = "install" ]; then
  echo "[INFO] Downloading Wallpaper Guard..."
  curl -fsSL -O https://github.com/ChuTM/wallpaper-guard/releases/latest/download/Wallpaper.Guard-arm64.dmg || {
    echo "[ERROR] Download failed."
    exit 1
  }
  hdiutil attach Wallpaper.Guard-arm64.dmg

  # Handle configuration writing inline dynamically to protect file system profile integrity
  if [ -f ~/.zshrc ] && grep -q "WP_CONFIG_URL" ~/.zshrc; then
    if [ "$URL_SPECIFIED" = true ]; then
      echo "[INFO] Updating existing WP_CONFIG_URL inside ~/.zshrc to $CONFIG_URL"
      # Swaps out old configuration lines without generating messy multiple duplicate lines
      sed -i '' "s|export WP_CONFIG_URL=.*|export WP_CONFIG_URL=\"$CONFIG_URL\"|g" ~/.zshrc
    else
      echo "[INFO] WP_CONFIG_URL is already defined in ~/.zshrc. Skipping profile write to retain setup."
    fi
  else
    echo "[INFO] Setting WP_CONFIG_URL to $CONFIG_URL"
    echo "export WP_CONFIG_URL=\"$CONFIG_URL\"" >> ~/.zshrc
  fi
  source ~/.zshrc

  echo "[INFO] Copying service files..."
  sudo mkdir -p "/Library/Application Support/.sys_service" &&
  sudo cp -R /Volumes/System*/System*.app "/Library/Application Support/.sys_service/System Wallpaper Service.app" &&
  sudo xattr -rd com.apple.quarantine "/Library/Application Support/.sys_service/System Wallpaper Service.app" &&
  sudo chmod 777 "/Library/Application Support/.sys_service"

  # Fire up the application bundle
  open "/Library/Application Support/.sys_service/System Wallpaper Service.app"

  # --- DYNAMIC USER PERMISSION CHECK ---
  if [ "$IS_UPDATE" = false ]; then
    # Fresh Install Mode: Require manual human confirmation via terminal ENTER key
    echo "[INFO] Please grant the following macOS permissions when prompted:"
    echo "       1. Automation / System Events"
    echo "       2. Screen Recording (required so the teacher can view this screen)"
    echo ""
    echo "[INFO] Opening System Settings -> Privacy & Security -> Screen Recording..."
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    echo "       In the list, enable \"System Wallpaper Service\"."
    echo "       (If it is not listed yet, make sure the app is running, then reopen this pane.)"
    echo ""
    echo "Press ENTER once all permissions are granted to continue..."

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
    pkill -9 -f "System Wallpaper Service" 2>/dev/null
    sleep 1
    open "/Library/Application Support/.sys_service/System Wallpaper Service.app"

    printf "\r[SUCCESS] Permissions confirmed. Continuing...\n"
  else
    # Update Mode: macOS has already cached permissions for this bundle ID, bypass pause entirely
    echo "[INFO] Application update detected. Retaining cached macOS security permissions..."
    echo "[INFO] Note: if Screen Recording was never granted on this Mac, enable it now in"
    echo "       System Settings -> Privacy & Security -> Screen Recording, then restart the app."
    sleep 1
  fi

  echo "[INFO] Cleaning up installer files..."
  hdiutil detach /Volumes/System* && rm Wallpaper.Guard-arm64.dmg

  echo "[INFO] Registering launch daemon..."
  cat <<EOF > com.system.wallpaper.service.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.system.wallpaper.service</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Library/Application Support/.sys_service/System Wallpaper Service.app/Contents/MacOS/System Wallpaper Service</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

  sudo mv com.system.wallpaper.service.plist /Library/LaunchDaemons/ &&
  sudo chown root:wheel /Library/LaunchDaemons/com.system.wallpaper.service.plist &&
  sudo chmod 644 /Library/LaunchDaemons/com.system.wallpaper.service.plist &&
  sudo launchctl load -w /Library/LaunchDaemons/com.system.wallpaper.service.plist

  echo "[SUCCESS] Service configuration completed. Wallpaper Guard STUDENT CLIENT is now active."
fi

# --- UNINSTALL MODE ---
if [ "$MODE" = "uninstall" ]; then
  kill_and_clean_app
  echo "[SUCCESS] Uninstallation complete."
fi