# InHand — Host (Teacher / Admin)

The teacher-side control center. It runs the Socket.io signaling server on
**port 7100**, the localhost-only admin dashboard, and the WebRTC
screen-sharing broker. Every student client connects to this server and shows
up in the dashboard in real time.

## Features

- **Admin dashboard** — `http://localhost:7100/admin`
  - live online/offline device list ("Monitored Clients")
  - per-device **View Screen** action
  - **Enable Configuration Mode** to lock client settings
- **Screen sharing (broadcast)** — click **Start Sharing**; every connected
  student opens a window showing the teacher's screen. Click **Stop Sharing**
  to close them all.
- **Persistent window (always on top)** — when checked, student share windows
  are locked: always on top and not closable by the student. When unchecked,
  students may close their window and reopen it from the client tray menu
  ("Reopen Teacher's Screen").
- **View a student's screen** — click **View Screen** on a device row; the
  student's live screen opens in a new window on top of the broadcast, without
  interrupting the broadcast to the other students. The viewed student sees a
  small, frameless tag: "Your teacher is viewing your screen".

## Getting Started

```bash
cd host
npm install
npm start
```

The dashboard opens automatically at `http://localhost:7100/admin`.

## Screen-Sharing Signaling (how it works)

1. **Broadcast** — the teacher captures a screen source and clicks **Start
   Sharing**. The main process signs `teacher-start-share` (Ed25519) and the
   server broadcasts it. Each student verifies the signature, opens a share
   window, and sends an ECIES-encrypted WebRTC offer; the host answers (and
   the server re-signs the answer on the way out). `teacher-stop-share`
   closes all student windows.
2. **View a student** — clicking **View Screen** makes the main process mint a
   one-time viewer token and open a viewer window. The window claims the token
   (`viewer-claim`), then emits `request-student-stream`; the server forwards a
   signed request to that student. The student's share window captures its
   screen (requires **Screen Recording** permission) and streams it back
   encrypted. When the viewer window closes, the server sends
   `stop-student-stream` so the capture stops.

All signaling goes through Socket.io on port 7100; media flows peer-to-peer
over WebRTC. The teacher's broadcast keeps running while a student screen is
viewed on top of it.

## Code Map

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process (ESM): Express + Socket.io server, keyring, signing, share signaling, viewer lifecycle |
| `lib/crypto.mjs` | Ed25519 signing, X25519 ECIES, scrypt key wrapping |
| `lib/keystore.mjs` | Password-protected keyring lifecycle (setup/unlock/rotate/change password) |
| `lib/audit.mjs` | JSONL audit log |
| `res/admin.html` | Admin dashboard markup (first-run setup + unlock gate, CSP) |
| `res/admin.script.js` | Dashboard logic: device list, config mode, share start/stop, view-student, whitelisted command composer |
| `res/share.html` | Shared window markup (local share preview + student viewer) |
| `res/share-renderer.js` | Share-window renderer: local preview and view-student stream playback |
| `res/style.css` | Dashboard styling |

## Security

- The admin UI/API is restricted to `localhost` traffic; state-changing `/api`
  calls require a per-session CSRF token.
- The teacher's **private keys never leave the main process**: the renderer
  submits intents over IPC, and `main.js` signs events and decrypts uplinks.
- Keys are stored password-encrypted (scrypt + AES-256-GCM, `0600`) and the
  teacher unlocks at every launch. Keys can be regenerated or the password
  changed from the dashboard.
- All privileged events are signed and replay-protected (nonce + 120 s).
- All student→teacher payloads are ECIES-encrypted.
- Privileged events from other network sockets are rejected unless their
  signature verifies; rejections are audited.
- **LAN-only mode**: the admin panel can send `lan-only {on, ttl}` / `fw-status`
  commands (whitelist in `../shared/commands.json`). Clients apply the lock via
  their local root helper (`install.sh -f`). See the project README's
  "LAN-only firewall" section for setup and the emergency
  `sudo sh /Library/Application Support/InHand/inhand-fwctl unlock` force-close.
