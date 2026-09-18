[Open Terminal](ssh://) and press \`Command + T\` to start a new session. Then, follow the steps below to get InHand up and running on your Mac.

### Using this page

Type `./` to auto insert `ihinstall.web.app/` in the input fields for quick access to the API URL.

## Installing via install.sh

**install.sh is for the STUDENT CLIENT only.** Run the following command in your terminal to execute the installation script. It downloads, installs, configures and registers the student client automatically — no `sudo` required.

:::cmd Install Script (Student Client)
sudo curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -a "___https://inhand-server.vercel.app___" -f
:::

- `-a / --api-url` sets the cloud API base URL (default `https://inhand-server.vercel.app`). Use the same URL for every student in the school.
- The installer walks you through granting **Screen Recording** permission (required so the teacher can view this screen).
- The service is installed per-user (`~/Library/Application Support/InHand/`) and auto-starts via a LaunchAgent. No root daemon, no world-writable directories.

- `-f / --firewall` additionally installs the LAN-only helper so the teacher
  can cut internet access while keeping the LAN working (see the README
  "LAN-only firewall" section). It prompts for admin **once** to install a
  single root daemon + pf anchor.
- Emergency force-close on a locked machine: `sudo inhand-fwctl unlock`.

> [!IMPORTANT]
> Teachers (host side) should NOT run this script. Use the separate admin app instead.

### Uninstalling

To uninstall the student client, run the following command. This will stop the service, remove all related files, and clean up any residual data.

:::cmd Uninstall Script
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -u
:::

### Updating (Manually)

To update the student client, re-run the installation script. It replaces the existing app while preserving your configuration.

:::cmd Update Script
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v &
:::

### Updating (in-bulk via the teacher)

The teacher can update **all clients at once** by sending the signed `update` command from the admin dashboard (Settings → command panel, or via a scheduled command). Each client verifies the teacher's signature, downloads the new version over HTTPS, checks the SHA-256 + code signature, and atomically replaces its own app — no `777` permissions, no `sudo`, no per-machine SSH needed.

Clients can also auto-update: the cloud can publish an update manifest at `/api/v1/update` (signed with the cloud key), and every client polls it on boot and every 4 hours.

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