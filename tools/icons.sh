#!/bin/sh
# Renders tools/icon.html to the site's icons (needs Google Chrome; macOS sips for resizing).
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --user-data-dir="$TMP/profile" --window-size=1024,1024 --screenshot="$TMP/icon.png" "file://$PWD/tools/icon.html" 2>/dev/null
sips -z 512 512 "$TMP/icon.png" --out site/icons/icon-512.png >/dev/null
sips -z 192 192 "$TMP/icon.png" --out site/icons/icon-192.png >/dev/null
sips -z 180 180 "$TMP/icon.png" --out site/icons/apple-touch-icon.png >/dev/null
rm -rf "$TMP"
ls -la site/icons
