# Wallpaper Guard 🖼️🛡️

A centralized management system for macOS desktop wallpapers, with built-in
classroom screen sharing. It consists of two apps:

- **Host (Admin)** — the teacher's control center: enforces wallpapers on every
  connected device, broadcasts the teacher's screen to all students, and lets
  the teacher view any student's screen.
- **Client (Student)** — a lightweight background utility on each student Mac
  that enforces the wallpaper and participates in screen sharing.

> [!NOTE]
> **macOS is required.** The Host and Client communicate over the local network
> via Socket.io on port 7100.

## Quick Download & Installation

### For Students (Client)

1. Download from the [download page](https://wallpg.web.app/), or run the
   installer script: `website/install.sh` (Apple Silicon only).
2. The installer registers the service, writes `WP_CONFIG_URL` to `~/.zshrc`,
   and walks the user through granting the required macOS permissions,
   including **Screen Recording** (needed for screen sharing).
   This installer is for the **student client only** — teachers should not run
   it on their machine.

### For Teachers (Host / Admin)

Download the latest `Wallpaper.Guard.Admin-...-arm64.dmg` from the
[GitHub Releases](https://github.com/ChuTM/wallpaper-guard/releases) page and
install it like a regular macOS app.

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

## Project Structure

```
/host      Teacher (Admin) Electron app — Express + Socket.io server on port
           7100, localhost-only admin dashboard, WebRTC share signaling.
/client    Student Electron app — background service with a tray icon, wallpaper
           enforcement, and screen-sharing windows.
/website   Landing/download page plus install.sh (student client installer).
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

Click the tray icon → **Set Server Address** and enter the Host URL
(e.g. `http://192.168.1.50:7100`). The client can also fetch its server
configuration from `https://wallpg.web.app/init_config.json`, overridable with
the `WP_CONFIG_URL` environment variable.

## Configuration

### Wallpaper
The default enforced wallpaper is
`/System/Library/CoreServices/DefaultDesktop.heic`. Change `wallpaperPath` in
`client/config.json` (or the `DEFAULT_PATH` constant in `client/main.js`).

### Server address
`client/config.json`:
```json
{ "serverUrl": "http://localhost:7100" }
```

### Build Executables

```bash
# In either /host or /client
npm version patch
npm prune --production
npm run dist
```

## Security Notes

- The admin dashboard is restricted to the machine running the Host.
- Remote clients communicate only over the Socket.io port (7100).
- Renderers use `contextIsolation` with `nodeIntegration` disabled.
- Screen sharing requires the user to grant **Screen Recording** permission in
  System Settings → Privacy & Security.
