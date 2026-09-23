#!/bin/zsh
# package-capture.sh — build InHand-Capture-arm64.dmg (Swift helper).
#
# Compiles the Swift capture helper, assembles it as an LSUIElement .app
# (com.inhand.capture, no dock icon), ad-hoc signs it, and produces the disk
# image with the exact name install.sh expects:
#     https://github.com/ChuTM/inhand/releases/latest/download/InHand-Capture-arm64.dmg
#
# Output: client/capture/dist/InHand-Capture-arm64.dmg

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CAPTURE_SRC="$ROOT/client/capture"
OUT_DIR="$CAPTURE_SRC/dist"
OUT_APP="$OUT_DIR/InHand Capture.app"
OUT_DMG="$OUT_DIR/InHand-Capture-arm64.dmg"
VERSION="$(node -p "require('$ROOT/client/package.json').version" 2>/dev/null || echo "2.0.0")"

echo "[1/4] Compiling Swift helper..."
zsh "$CAPTURE_SRC/build.sh"

echo "[2/4] Assembling app bundle ($VERSION)..."
rm -rf "$OUT_APP"
mkdir -p "$OUT_APP/Contents/MacOS"
cp "$CAPTURE_SRC/dist/inhand-capture" "$OUT_APP/Contents/MacOS/InHand Capture"
chmod +x "$OUT_APP/Contents/MacOS/InHand Capture"

cat > "$OUT_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>InHand Capture</string>
  <key>CFBundleIdentifier</key>
  <string>com.inhand.capture</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>InHand Capture</string>
  <key>CFBundleDisplayName</key>
  <string>InHand Capture</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

echo "[3/4] Ad-hoc signing..."
codesign --force --sign - "$OUT_APP"
codesign -dv "$OUT_APP" 2>&1 | grep -E "Identifier|Signature" | head -2

echo "[4/4] Creating disk image..."
rm -f "$OUT_DMG"
hdiutil create -volname "InHand Capture" -srcfolder "$OUT_APP" -ov -format UDZO "$OUT_DMG" >/dev/null
echo
echo "[DONE] $OUT_DMG ($(du -h "$OUT_DMG" | awk '{print $1}'))"
echo "       Upload as a GitHub release asset named InHand-Capture-arm64.dmg"
echo "       so install.sh --scope=capture can fetch it."
