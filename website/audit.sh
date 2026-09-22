#!/bin/sh
# audit.sh — InHand Student health & privilege audit
#
# Tells a teacher (or the student) whether this machine still has the main app,
# the auto-start agent, the Screen Recording grant, the Capture helper, and the
# LAN-only firewall helper that InHand requires — i.e. whether the student
# removed or disabled something. Every line prints [PASS] / [FAIL] / [ ?? ],
# then a summary.
#
# Component layout (see install.sh):
#   - Main app:  ~/Library/Application Support/InHand/InHand Student.app
#   - Capture:   /Library/Application Support/InHand/InHand Capture.app (root)
#   - Firewall:  /Library/Application Support/InHand/* + com.inhand.fw daemon
#
# Usage:
#   sh audit.sh             check only (no root needed)
#   sh audit.sh -f          check + quick fixes; re-run with sudo for root fixes
#
# Root fixes (helper reinstall) require: sudo sh audit.sh -f

INHAND_DIR="/Library/Application Support/InHand"
APP_DIR="$HOME/Library/Application Support/InHand"
APP_BUNDLE="$APP_DIR/InHand Student.app"
CAPTURE_BUNDLE="$INHAND_DIR/InHand Capture.app"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.inhand.student.plist"
LAUNCH_DAEMON="/Library/LaunchDaemons/com.inhand.fw.plist"
FW_DAEMON="com.inhand.fw"
INSTALL_HINT='sudo curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -f'
UPDATE_HINT='curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v'

pass=0; fail=0; unknown=0; faillist=""

check() { # check <name> <PASS|FAIL|UNKNOWN> <detail>
	case "$2" in
		PASS)
			pass=$((pass + 1))
			printf "[PASS] %s — %s\n" "$1" "$3"
			;;
		FAIL)
			fail=$((fail + 1))
			faillist="$faillist $1"
			printf "[FAIL] %s — %s\n" "$1" "$3"
			;;
		*)
			unknown=$((unknown + 1))
			printf "[ ?? ] %s — %s\n" "$1" "$3"
			;;
	esac
}

echo "## InHand Student Audit"
echo "Device: $(hostname)   User: $(whoami)   Date: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# ---- 1. App installed -------------------------------------------------------
if [ -d "$APP_BUNDLE" ]; then
	check app-installed PASS "found at $APP_BUNDLE"
else
	check app-installed FAIL "MISSING at $APP_BUNDLE — reinstall: $INSTALL_HINT"
fi

# ---- 2. App signature -------------------------------------------------------
if [ -d "$APP_BUNDLE" ]; then
	if codesign --verify --deep --strict "$APP_BUNDLE" >/dev/null 2>&1; then
		check app-signature PASS "codesign verification OK"
	else
		check app-signature FAIL "codesign verification FAILED — app was modified or re-signed"
	fi
fi

# ---- 3. LaunchAgent (auto-start at login) -----------------------------------
if [ -f "$LAUNCH_AGENT" ]; then
	if launchctl print "gui/$(id -u)/com.inhand.student" >/dev/null 2>&1; then
		check launch-agent PASS "registered and loaded"
	else
		check launch-agent FAIL "plist exists but service is NOT loaded — fix: launchctl bootstrap \"gui/$(id -u)\" \"$LAUNCH_AGENT\""
	fi
else
	check launch-agent FAIL "MISSING $LAUNCH_AGENT — auto-start removed (reinstall: $INSTALL_HINT)"
fi

# ---- 4. Screen Recording permission ------------------------------------------
# NOTE: once the Capture helper split ships, the grant belongs to
# "InHand Capture" (root-owned, never updated) — the main app has no TCC grant.
if command -v swift >/dev/null 2>&1; then
	if swift -e 'import CoreGraphics; exit(CGPreflightScreenCaptureAccess() ? 0 : 1)' >/dev/null 2>&1; then
		check screen-recording PASS "granted — teacher can view this screen"
	else
		check screen-recording FAIL "NOT granted — System Settings → Privacy & Security → Screen Recording → enable InHand Student (or InHand Capture), then quit & reopen the app"
	fi
else
	check screen-recording UNKNOWN "swift not available, cannot probe TCC"
fi

# ---- 4b. Capture helper (root-owned screen capture) ---------------------------
if [ -d "$CAPTURE_BUNDLE" ]; then
	if codesign --verify --deep --strict "$CAPTURE_BUNDLE" >/dev/null 2>&1; then
		check capture-installed PASS "found at $CAPTURE_BUNDLE (root-owned)"
	else
		check capture-installed PASS "present (unsigned/ad-hoc is expected) at $CAPTURE_BUNDLE"
	fi
else
	check capture-installed UNKNOWN "not installed — Capture split not shipped on this build (main app still holds Screen Recording)"
fi

# ---- 5. Firewall helper files (LAN-only capability) --------------------------
fw_missing=""
for f in "$INHAND_DIR/daemon.mjs" "$INHAND_DIR/inhand-fwctl" "$LAUNCH_DAEMON"; do
	[ -f "$f" ] || fw_missing="$fw_missing $(basename "$f")"
done
if [ -z "$fw_missing" ]; then
	check fw-helper PASS "daemon.mjs + inhand-fwctl + com.inhand.fw.plist present"
else
	check fw-helper FAIL "helper removed:$fw_missing — reinstall with: $INSTALL_HINT"
fi

# ---- 6. Firewall daemon running ----------------------------------------------
if launchctl print "system/$FW_DAEMON" >/dev/null 2>&1; then
	check fw-daemon PASS "$FW_DAEMON loaded"
else
	check fw-daemon FAIL "firewall daemon NOT running — fix: sudo sh \"$INHAND_DIR/inhand-fwctl\" ensure-anchor"
fi

# ---- 7. Teacher key configured -----------------------------------------------
if [ -f "$INHAND_DIR/fw-config.json" ]; then
	check fw-key PASS "key file present"
else
	check fw-key FAIL "no teacher key — syncs automatically on discovery, or: sudo sh \"$INHAND_DIR/inhand-fwctl\" setkey <public-key>"
fi

# ---- Summary ------------------------------------------------------------------
echo ""
total=$((pass + fail + unknown))
printf "SUMMARY: %d/%d passed (%d failed, %d unknown)\n" "$pass" "$total" "$fail" "$unknown"
if [ "$fail" -gt 0 ]; then
	echo "Failed items:$faillist"
fi
echo ""

# ---- Quick fixes ---------------------------------------------------------------
if [ "$1" = "-f" ]; then
	echo "## Quick fixes"
	# Re-register the launch agent (no root needed)
	if [ -f "$LAUNCH_AGENT" ]; then
		launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT" >/dev/null 2>&1 || true
		launchctl kickstart -k "gui/$(id -u)/com.inhand.student" >/dev/null 2>&1 || true
		echo "[fix] launch agent re-registered + restarted"
	fi
	# Open Screen Recording settings (grant itself cannot be automated)
	open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" >/dev/null 2>&1
	echo "[fix] Screen Recording settings opened — enable InHand Student (or InHand Capture), then quit & reopen the app"
	# Reinstall the Capture helper if it exists as a release asset (root-only)
	if [ "$(id -u)" = "0" ] && [ ! -d "$CAPTURE_BUNDLE" ]; then
		echo "[fix] Capture helper missing — run: $UPDATE_HINT --scope=capture"
	fi
	# Root-only fixes
	if [ "$(id -u)" = "0" ]; then
		BUNDLE_HELPERS="$APP_DIR/InHand Student.app/Contents/Resources/helpers"
		if [ -d "$BUNDLE_HELPERS" ]; then
			mkdir -p "$INHAND_DIR"
			cp "$BUNDLE_HELPERS/daemon.mjs" "$BUNDLE_HELPERS/inhand-fwctl" "$INHAND_DIR/" 2>/dev/null
			chmod 755 "$INHAND_DIR/inhand-fwctl"
			if [ -f "$BUNDLE_HELPERS/com.inhand.fw.plist" ] && [ ! -f "$LAUNCH_DAEMON" ]; then
				cp "$BUNDLE_HELPERS/com.inhand.fw.plist" "$LAUNCH_DAEMON"
			fi
			launchctl bootout "system/$FW_DAEMON" >/dev/null 2>&1 || true
			sleep 1
			if [ -f "$LAUNCH_DAEMON" ]; then
				launchctl bootstrap system "$LAUNCH_DAEMON" >/dev/null 2>&1 || true
			fi
			launchctl kickstart -k "system/$FW_DAEMON" >/dev/null 2>&1 || true
			sh "$INHAND_DIR/inhand-fwctl" ensure-anchor >/dev/null 2>&1 || true
			echo "[fix] firewall helper re-copied from app bundle, daemon restarted, pf anchor ensured"
		else
			echo "[fix] app bundle helpers not found — reinstall the student app first"
		fi
	else
		echo "[fix] run with sudo for root fixes: sudo sh \"$0\" -f"
	fi
	echo ""
	echo "Re-run: sh \"$0\" to confirm everything passes."
fi
