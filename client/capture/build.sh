#!/bin/zsh
# build.sh — compile the Swift InHand Capture helper.
#
# Output: dist/inhand-capture (single arm64 binary, a few MB).
set -e
cd "$(dirname "$0")"
mkdir -p dist
swiftc -O -swift-version 5 -o dist/inhand-capture \
  Sources/main.swift \
  Sources/ErrorLog.swift \
  Sources/WebSocketServer.swift \
  Sources/CaptureEngine.swift \
  Sources/MockEngine.swift \
  Sources/JPEG.swift \
  -framework ScreenCaptureKit \
  -framework CoreMedia \
  -framework CoreVideo \
  -framework CoreGraphics \
  -framework ImageIO \
  -framework CoreText \
  -framework AppKit \
  -framework Network \
  -framework UniformTypeIdentifiers
echo "[OK] built dist/inhand-capture ($(du -h dist/inhand-capture | awk '{print $1}'))"
