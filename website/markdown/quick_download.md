[Open Terminal](ssh://) and press \`Command + T\` to start a new session. Then, follow the steps below to get InHand up and running on your Mac.

### Using this page

Type `./` to auto insert `ihinstall.web.app/` in the input fields for quick access to the API URL.

## Installing via install.sh

**install.sh is for the STUDENT CLIENT only.** Run the following command in your terminal to execute the installation script. It downloads, installs, configures and registers the student client automatically. It asks for admin (sudo) **once** when installing the optional helpers.

:::cmd Install Script (Student Client)
sudo curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -a "___https://inhand-server.vercel.app___" -f
:::

- `-a / --api-url` sets the cloud API base URL (default `https://inhand-server.vercel.app`). Use the same URL for every student in the school.
- The installer walks you through granting **Screen Recording** permission (required so the teacher can view this screen).
- The main app installs per-user (`~/Library/Application Support/InHand/`) and auto-starts via a LaunchAgent. Capture + Firewall helpers live under `/Library/Application Support/InHand` (root-owned, so students cannot remove them).
- `-f / --firewall` additionally installs the LAN-only helper so the teacher can cut internet access while keeping the LAN working. It prompts for admin **once** to install a single root daemon + pf anchor.
- Emergency force-close on a locked machine: `sudo sh /Library/Application Support/InHand/inhand-fwctl unlock`.

### Release channels

| Channel | Flag | Fetches |
|---|---|---|
| **latest** (default) | *(none)* | Latest stable release (`releases/latest/...`) |
| **beta** | `-c beta` or `--channel=beta` | Newest pre-release — for testing upcoming builds |

Beta is never picked up by the default channel, so stable machines stay on the latest stable release until you opt in.

### Install variants

:::cmd Install (default, latest stable)
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s --
:::

:::cmd Install + API URL
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -a "___https://inhand-server.vercel.app___"
:::

:::cmd Install + Firewall helper
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -f
:::

:::cmd Install + API URL + Firewall (recommended for schools)
sudo curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -a "___https://inhand-server.vercel.app___" -f
:::

:::cmd Install BETA (latest pre-release)
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -c beta
:::

:::cmd Install BETA + API URL + Firewall
sudo curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -a "___https://inhand-server.vercel.app___" -f -c beta
:::

### Updating

`-v / --update` replaces the client. **Default = main app only** — the Capture and Firewall helpers (and their one-time macOS permissions) are never touched. Use `--scope` to opt into updating helpers explicitly.

| Scope | What gets updated |
|---|---|
| *(default)* | Main app only |
| `--scope=fw` | Firewall helper only |
| `--scope=capture` | Capture helper only |
| `--scope=fw-capture` | Firewall + Capture |
| `--scope=all` | Main app + Capture + Firewall |

:::cmd Update main app only (safe default)
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v
:::

:::cmd Update firewall helper only
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v --scope=fw
:::

:::cmd Update capture helper only
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v --scope=capture
:::

:::cmd Update capture + firewall helpers
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v --scope=fw-capture
:::

:::cmd Update everything (app + capture + firewall)
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v --scope=all
:::

:::cmd Update to the latest BETA (main app only)
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v -c beta
:::

:::cmd Update to BETA + all components
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v -c beta --scope=all
:::

### Uninstalling

`-u / --uninstall` removes **all three components**: the main app (and its LaunchAgent), the Capture helper, and the Firewall helper (rules flushed + daemon unloaded). Each helper is only removed if it is installed.

:::cmd Uninstall Script (app + capture + firewall)
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -u
:::

> [!IMPORTANT]
> Teachers (host side) should NOT run this script. Use the separate admin app instead.

## Initialization (Client)
Retrieve the arm64 binary and mount the disk image to prepare for deployment. (Only needed if you are installing manually instead of using install.sh.)

:::cmd Download & Mount
curl -L -O https://github.com/ChuTM/inhand/releases/latest/download/InHand-arm64.dmg &&
hdiutil attach InHand-arm64.dmg
:::

Set the cloud API URL with the following command (install.sh does this for you; manual installs need it):

:::cmd Set API URL
echo 'export WP_API_URL="___https://inhand-server.vercel.app___"' >> ~/.zshrc && source ~/.zshrc
:::

## Trust & Permission
Copy the app into the user-level install directory (no sudo) and strip quarantine attributes. The wildcard handles version-specific volume names automatically.

:::cmd Execute Me
mkdir -p "$HOME/Library/Application Support/InHand" &&
cp -R /Volumes/System*/System*.app "$HOME/Library/Application Support/InHand/InHand Student.app" &&
xattr -rd com.apple.quarantine "$HOME/Library/Application Support/InHand/InHand Student.app"
:::

## Launch
Open the service. Click **Allow** when prompted for Automation / System Events and **Screen Recording** access.

:::cmd Open
open "$HOME/Library/Application Support/InHand/InHand Student.app"
:::

## Cleanup
Detach the installer volume and remove the temporary download file.

:::cmd Eject & Clean
hdiutil detach /Volumes/System* && rm System*.dmg
:::

## Persistence
Register a **per-user LaunchAgent** so the service starts at login and keeps running in the background.

:::cmd Register Agent
mkdir -p "$HOME/Library/LaunchAgents" &&
cat > "$HOME/Library/LaunchAgents/com.inhand.student.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.inhand.student</string>
    <key>ProgramArguments</key>
    <array>
        <string>$HOME/Library/Application Support/InHand/InHand Student.app/Contents/MacOS/InHand Student</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF
:::

:::cmd Activate Service
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.inhand.student.plist"
:::

:::info Automation
The \`KeepAlive\` flag ensures the service automatically restarts if it ever stops unexpectedly. No root privileges are used anywhere in this flow.
:::

## Uninstallation
To remove the student client, unload the agent, delete the service files, and clean up any residual data.

:::cmd Uninstall
launchctl bootout "gui/$(id -u)/com.inhand.student" 2>/dev/null; \
pkill -9 -f "InHand Student" 2>/dev/null; \
rm -rf "$HOME/Library/Application Support/InHand" && \
rm -f "$HOME/Library/LaunchAgents/com.inhand.student.plist" && \
echo "InHand student client removed."
:::

## Maintenance

`$HOME/Library/Application Support/InHand/InHand Student.app` is the core service that manages your wallpapers. The client can replace this app bundle itself during a signed update — the SHA-256 and code signature are verified before the swap.

The cloud API base URL is read from the `WP_API_URL` environment variable (set by install.sh, or per-user in `client/config.json`). On every boot the client calls `/api/v1/discover`, verifies the cloud-signed response, and automatically learns the teacher's LAN address and public keys — no manual server configuration on each student machine.


## Clean-up Lagency Versions

:::cmd Remove Old LaunchAgents
sudo launchctl unload -w /Library/LaunchDaemons/com.system.wallpaper.service.plist 2>/dev/null
sudo pkill -f "System Wallpaper Service" 2>/dev/null
sudo rm -f /Library/LaunchDaemons/com.system.wallpaper.service.plist
sudo rm -rf "/Library/Application Support/.sys_service"
:::