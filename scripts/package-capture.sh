#!/bin/zsh
# package-capture.sh — build InHand-Capture-arm64.dmg for install.sh --scope=capture
#
# Takes a stock Electron.app, stamps it as "InHand Capture" (com.inhand.capture,
# LSUIElement, no dock icon), installs client/capture as the app bundle, and
# produces a disk image named exactly what install.sh expects:
#     https://github.com/ChuTM/inhand/releases/latest/download/InHand-Capture-arm64.dmg
#
# Usage:
#   ./scripts/package-capture.sh [path-to-Electron.app]
#
# The Electron.app is located (first match wins):
#   1. the CLI argument
#   2. $ELECTRON_APP
#   3. client/node_modules/electron/dist/Electron.app
#   4. /tmp/eltest/electron44/Electron.app  (dev fallback)
#
# Output: client/capture/dist/InHand-Capture-arm64.dmg

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CAPTURE_SRC="$ROOT/client/capture"
OUT_DIR="$CAPTURE_SRC/dist"
OUT_APP="$OUT_DIR/InHand Capture.app"
OUT_DMG="$OUT_DIR/InHand-Capture-arm64.dmg"

echo "[1/4] Locating a base Electron.app..."
if [ -n "$1" ]; then
  ELECTRON_APP="$1"
elif [ -z "$ELECTRON_APP" ] && [ -d "$ROOT/client/node_modules/electron/dist/Electron.app" ]; then
  ELECTRON_APP="$ROOT/client/node_modules/electron/dist/Electron.app"
elif [ -z "$ELECTRON_APP" ]; then
  ELECTRON_APP="/tmp/eltest/electron44/Electron.app"
fi
if [ ! -d "$ELECTRON_APP" ]; then
  echo "[ERROR] Electron.app not found at: $ELECTRON_APP" >&2
  exit 1
fi
echo "      using $ELECTRON_APP"

echo "[2/4] Stamping the app bundle..."
rm -rf "$OUT_APP"
mkdir -p "$OUT_DIR"
cp -R "$ELECTRON_APP" "$OUT_APP"
if [ -f "$OUT_APP/Contents/MacOS/Electron" ]; then
  mv "$OUT_APP/Contents/MacOS/Electron" "$OUT_APP/Contents/MacOS/InHand Capture"
elif [ ! -f "$OUT_APP/Contents/MacOS/InHand Capture" ]; then
  echo "[ERROR] no main executable found in $OUT_APP/Contents/MacOS" >&2
  exit 1
fi
rm -f "$OUT_APP/Contents/Resources/app.asar"

INFO="$OUT_APP/Contents/Info.plist"
plutil -replace CFBundleName -string "InHand Capture" "$INFO"
plutil -replace CFBundleDisplayName -string "InHand Capture" "$INFO"
plutil -replace CFBundleIdentifier -string "com.inhand.capture" "$INFO"
plutil -replace CFBundleExecutable -string "InHand Capture" "$INFO"
plutil -replace CFBundleShortVersionString -string "$(node -p "require('$CAPTURE_SRC/package.json').version")" "$INFO" 2>/dev/null || true
plutil -insert LSUIElement -bool true "$INFO" 2>/dev/null || plutil -replace LSUIElement -bool true "$INFO" 2>/dev/null || true

echo "[3/4] Installing capture sources..."
mkdir -p "$OUT_APP/Contents/Resources/app/node_modules"
cp "$CAPTURE_SRC/main.js" \
   "$CAPTURE_SRC/capture-renderer.html" \
   "$CAPTURE_SRC/capture-renderer.js" \
   "$CAPTURE_SRC/package.json" \
   "$OUT_APP/Contents/Resources/app/"
if [ -d "$CAPTURE_SRC/node_modules/ws" ]; then
  cp -R "$CAPTURE_SRC/node_modules/ws" "$OUT_APP/Contents/Resources/app/node_modules/"
else
  echo "[WARN] ws dependency missing in $CAPTURE_SRC/node_modules — run: cd client/capture && npm install --omit=dev" >&2
fi

echo "[4/4] Creating disk image..."
rm -f "$OUT_DMG"
hdiutil create -volname "InHand Capture" -srcfolder "$OUT_APP" -ov -format UDZO "$OUT_DMG" >/dev/null
echo
echo "[DONE] $OUT_DMG"
echo "       Upload as a GitHub release asset named InHand-Capture-arm64.dmg"
echo "       so install.sh --scope=capture can fetch it."
