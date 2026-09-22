# InHand 🖼️🛡️

InHand is a classroom management system for macOS: wallpapers, screen sharing,
and lockdown-style commands, all controlled by the teacher from one dashboard.
It consists of two apps:

- **Host (Admin)** — the teacher's control center: enforces wallpapers on every
  connected device, broadcasts the teacher's screen to all students, and lets
  the teacher view any student's screen.
- **Client (Student)** — a lightweight background utility on each student Mac
  that enforces the wallpaper and participates in screen sharing. It is split
  into three components so updates never reset one-time permissions:
  - **Main app** (`InHand Student.app`, user dir) — UI-less, updated freely.
  - **Capture** (`InHand Capture.app`, `/Library`, root-owned) — screen
    capture helper; holds the Screen Recording grant; updated almost never.
  - **Firewall** (`com.inhand.fw` root daemon) — LAN-only helper; one admin
    prompt at install; updated almost never.

> [!NOTE]
> **macOS is required.** The Host and Client communicate over the local network
> via Socket.io on port 7100.

## Quick Download & Installation

### For Students (Client)

1. Download from the [download page](https://ihinstall.web.app/), or run the
   installer script: `website/install.sh` (Apple Silicon only).
2. The installer registers a per-user LaunchAgent, writes `WP_API_URL` to the
   shell profile (set it with `-a/--api-url`), and walks the user through
   granting the required macOS permissions, including **Screen Recording**
   (needed so the teacher can view this screen).
   This installer is for the **student client only** — teachers should not run
   it on their machine.

**Updating — important:** `install.sh -v` **only updates the main app** by
default. The Capture helper and the Firewall helper (both root-owned, and both
holding one-time macOS grants) are **never touched** during an update, so their
permissions are never reset. To update a helper explicitly, opt in with
`--scope`:

```bash
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v                # main app only (default, safe)
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v --scope=fw          # firewall helper only
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v --scope=capture     # capture helper only
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v --scope=fw-capture  # capture + firewall
curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -v --scope=all         # everything
```

> Why: macOS records permissions (Screen Recording, etc.) against the app's
> signature identity. Replacing an unsigned app resets that grant. Splitting
> screen capture (and the firewall) into root-owned helpers that are updated
> almost never keeps the one-time grants stable; the main app can be updated
> freely.

**Building the Capture helper:** `./scripts/package-capture.sh` stamps a stock
`Electron.app` as `InHand Capture.app` (com.inhand.capture, LSUIElement),
bundles `client/capture/`, and produces
`client/capture/dist/InHand-Capture-arm64.dmg` — upload it as a GitHub release
asset named exactly `InHand-Capture-arm64.dmg` so `install.sh --scope=capture`
can fetch it.

### For Teachers (Host / Admin)

Download the latest `InHand.Admin-...-arm64.dmg` from the
[GitHub Releases](https://github.com/ChuTM/inhand/releases) page and
install it like a regular macOS app.

## Security Architecture

- **Teacher keys** — on first launch the Host generates an **Ed25519** signing
  key pair and an **X25519** encryption key pair. Private keys are encrypted
  with a password (scrypt + AES-256-GCM) and stored at `0600` in the Host's
  user data. The teacher unlocks with the password on every launch and can
  regenerate keys or change the password from the dashboard.
- **Cloud discovery (one school, one teacher)** — the teacher registers the
  school's **public IP** with the officially hosted server (`/api/v1/admin/register`),
  providing the LAN IP and public keys. Students call `/api/v1/discover` from
  the same public IP, verify the **cloud's signature** on the response, and
  learn the teacher's LAN address and public keys — no PIN, no per-student
  setup.
- **Signed commands** — every privileged teacher event (share, view, commands)
  is **Ed25519-signed** and replay-protected (nonce + 120 s window). The client
  verifies before acting; unsigned events are rejected and audited.
- **Encrypted uplink** — everything a student sends (registration, command
  results, WebRTC offers/ICE) is **ECIES-encrypted** (X25519 + HKDF +
  AES-256-GCM) to the teacher's public key, so only the teacher can read it.
- **Command whitelist** — teachers can only send commands defined in
  `shared/commands.json` (add/remove commands by editing that file and
  releasing an update). No free shell on clients.
- **LAN gate** — commands, always-on-top and screen viewing are only honored
  on private addresses (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`).
- **Self-update** — the client verifies HTTPS downloads by SHA-256, `codesign`
  and Gatekeeper before atomically replacing itself. The cloud can also publish
  update manifests at `/api/v1/update` (cloud-signed).
- **No root** — the student client runs from `~/Library/Application Support/
  InHand/` under a per-user LaunchAgent. No sudo, no root daemon, no
  world-writable directories.
- **Audit logs** — both sides append a JSONL audit log (key events: setup,
  unlock, key rotation, commands, rejected/unauthenticated events).

## Features

- **Real-time monitoring** — the admin dashboard shows which devices are
  online/offline.
- **Wallpaper enforcement** — the client resets the wallpaper via native
  `osascript` every `checkInterval` milliseconds.
- **Lockdown / Config mode** — toggle from the Host to stop clients from
  changing server settings or quitting the app.
- **Screen sharing (broadcast)** — the teacher shares their screen; every
  student Mac pops up a viewing window automatically.
- **View a student's screen** — the teacher can open any student's live screen
  on top of the broadcast, without interrupting the broadcast. The student sees
  a small, frameless "Your teacher is viewing your screen" tag (no controls).
- **Persistent share windows** — with "Persistent window (always on top)"
  checked, student windows are locked (always on top, cannot be closed);
  otherwise students can close them and reopen them anytime from the client
  tray menu ("Reopen Teacher's Screen").
- **LAN-only mode (external access cut)** — the teacher can cut every client's
  internet access with one signed command; machines stay usable on the LAN.
  Optional helper, see [LAN-only firewall](#lan-only-firewall-optional).

## LAN-only firewall (optional)

The teacher can switch a client (or all clients) into **LAN-only mode**: all
outbound traffic to the internet is blocked by the macOS packet filter (pf),
while LAN traffic keeps working — the client stays reachable, the screen-share
and command channels keep functioning, but web/cloud access is cut.

```
1. Install the helper once per student machine (single admin prompt):
     curl -fsSL https://ihinstall.web.app/install.sh | zsh -s -- -f
   (Update it later with: `... | zsh -s -- -v --scope=fw`)
2. In the teacher's admin panel (Commands) send:
     lan-only  { on: true,  ttl: 60 }   → lock (auto-release in 60 min)
     lan-only  { on: false }            → release
     fw-status {}                       → query each client's lock state
```

**How it works**

- `install.sh -f` installs ONE tiny root daemon (`com.inhand.fw`,
  `client/helper/daemon.mjs`) plus a `inhand-fwctl` CLI. Everything else in the
  project stays rootless — this is the single privileged component.
- The daemon applies / removes a **named pf anchor** (`com.inhand`);
  it never edits `/etc/pf.conf`.
- Rules: block all outbound → pass private ranges (10/8, 172.16/12,
  192.168/16, 100.64/10), loopback, link-local, multicast, DHCP, and DNS (53).
- The teacher's key syncs to the daemon automatically on discovery and is
  **overwritten whenever the teacher rotates it** — the client detects a
  fingerprint mismatch and re-pushes the new key (the daemon accepts
  overwrites; a student who can swap keys themselves is not worth fighting,
  unlock still requires the teacher's signature). **Unlock requires the
  teacher's Ed25519 signature** — the client re-forwards the original signed
  command, and the daemon re-verifies it against its own copy of the key.
  Students cannot unlock.
- Defaults (changeable per command via `ttl`): auto-release after 60 minutes;
  the lock survives app quit and reboot (re-applied by launchd on boot, and
  auto-expires when the TTL elapses).

**Manual force-close / emergency** (run on the student machine, as admin):

```bash
sudo sh /Library/Application Support/InHand/inhand-fwctl unlock
```

Or, bypassing everything in one shot:

```bash
sudo /sbin/pfctl -a com.inhand -F all
sudo rm -f "/Library/Application Support/InHand/fw-state.json"
```

Other `inhand-fwctl` commands:

```bash
sudo sh /Library/Application Support/InHand/inhand-fwctl status                     # lock state + teacher key status
sudo sh /Library/Application Support/InHand/inhand-fwctl lock --ttl=60              # manually apply LAN-only mode
sudo sh /Library/Application Support/InHand/inhand-fwctl setkey <base64_pub>        # update the teacher key (after rotation)
sudo sh /Library/Application Support/InHand/inhand-fwctl uninstall                  # flush rules, unload daemon, remove files
```

**Operational notes & caveats**

- The daemon rejects stale timestamps, replayed nonces, and any event not
  signed by the configured teacher key; all ops are logged to
  `/Library/Application Support/InHand/fw.log`.
- After the teacher rotates keys, clients **re-sync automatically** on their
  next discovery/heartbeat (the daemon's key is overwritten). Only helpers
  installed before the keyFingerprint feature need a manual
  `sudo sh /Library/Application Support/InHand/inhand-fwctl setkey <pub>` once.
- This is a classroom **policy control, not a security boundary**: a student
  with admin rights can unload the daemon or boot another OS. Physical control
  is the real boundary here.
- Allowing DNS (port 53) keeps name resolution working but is a potential
  DNS-tunnel channel; remove the `to port 53` line in `fw.rules` if that
  matters in your environment.
- The helper is served from `website/firewall/` — keep it in sync with
  `client/helper/` when releasing updates.

## Project Structure

```
/host      Teacher (Admin) Electron app — Express + Socket.io server on port
           7100, localhost-only admin dashboard, WebRTC share signaling.
/client    Student Electron app — background service with a tray icon, wallpaper
           enforcement, and screen-sharing windows. Split: main app + Capture
           helper (screen capture) + firewall helper (root daemon).
/website   Landing/download page plus install.sh (student client installer
           with scoped updates) and audit.sh (health/privilege audit).
/tools     Cloud server (registration + discover + update signing). Runs
           locally (`tools/server/server.mjs`) or serverless on Vercel with
           Firebase Firestore (`api/` functions). See tools/server/README.md.
```

## Technical Architecture

### Host (Admin)
- **Framework**: Electron
- **Server**: Express.js (UI/API) + Socket.io (real-time signaling), port 7100
- **Security**: the admin UI/API are restricted to `localhost`
- **Screen sharing**: WebRTC — students' share windows send offers, the host
  answers with the teacher's screen stream; "view student" windows request and
  render a student's stream

### Client (Student)
- **Framework**: Electron (background service + tray)
- **Communication**: socket.io-client
- **Engine**: runs `osascript` to interact with macOS System Events
- **Screen sharing**: share windows capture the screen (Screen Recording
  permission required) and stream it to the teacher when requested
- **Capture helper** (split target): `InHand Capture.app` owns the screen
  capture + the Screen Recording grant; the main app consumes the stream via
  local IPC. Updating the main app never resets the grant.

## Development Installation & Setup

### Prerequisites
- Node.js 16 or higher
- macOS (required for wallpaper enforcement and screen sharing)

### 1. Set up the Host

```bash
cd host
npm install
npm start
```

The admin dashboard opens automatically at `http://localhost:7100/admin`.

### 2. Set up the Client

```bash
cd client
npm install
npm start
```

On first start the client performs **cloud discovery**: it calls
`/api/v1/discover` on the API server (env `WP_API_URL`, default
`https://inhand-server.vercel.app`), verifies the cloud signature, and learns the
teacher's LAN address and public keys automatically — no manual server address
entry. If the cloud is unreachable, a previously cached (unexpired) discovery
is reused; otherwise the client falls back to `serverUrl` in `client/config.json`.

## Configuration

### Wallpaper
The default enforced wallpaper is
`/System/Library/CoreServices/DefaultDesktop.heic`. Change `wallpaperPath` in
`client/config.json`.

### Cloud API / server address
Priority order: `WP_API_URL` env var → `client/config.json` `apiUrl` →
default. The same env var is set by `website/install.sh` (`-a/--api-url`).
`client/config.json`:
```json
{ "apiUrl": "https://inhand-server.vercel.app", "serverUrl": "http://localhost:7100" }
```

### Command whitelist
`shared/commands.json` (and its bundled copy `client/commands.json`) defines
every command the teacher may send. To add/remove commands, edit that file and
ship an update.

### Build Executables

```bash
# In either /host or /client
npm version patch
npm prune --production
npm run dist
```

## Security Notes

- The admin dashboard and `/api` are restricted to the machine running the Host
  (plus a CSRF token for state-changing requests).
- All privileged teacher→client events are Ed25519-signed and replay-protected.
- All client→teacher payloads are ECIES-encrypted to the teacher's public key.
- Clients only honor commands/screen sharing on private LAN addresses.
- Renderers use `contextIsolation` + `sandbox`, with `nodeIntegration` disabled.
- Screen sharing requires the user to grant **Screen Recording** permission in
  System Settings → Privacy & Security.
