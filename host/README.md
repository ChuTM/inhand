# Wallpaper Guard — Host (Teacher / Admin)

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

1. **Broadcast** — the teacher captures a screen source and emits
   `teacher-start-share` (with the `persistent` flag). Each student opens a
   share window, which sends a WebRTC offer back to the host; the host answers
   with the teacher's stream. `teacher-stop-share` closes all student windows.
2. **View a student** — the host opens a viewer window, which registers as a
   `viewer` and emits `request-student-stream`. The student's share window
   captures its screen (requires **Screen Recording** permission) and streams
   it back. When the viewer window closes, the server sends
   `stop-student-stream` to that student so the capture stops.

All signaling goes through Socket.io on port 7100; media flows peer-to-peer
over WebRTC.

## Code Map

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process (ESM): Express + Socket.io server, share signaling handlers, viewer lifecycle |
| `res/admin.html` | Admin dashboard markup |
| `res/admin.script.js` | Dashboard logic: device list, config mode, share start/stop, view-student |
| `res/share.html` | Shared window markup (local share preview + student viewer) |
| `res/share-renderer.js` | Share-window renderer: local preview and view-student stream playback |
| `res/style.css` | Dashboard styling |

## Security

- The admin UI/API is restricted to `localhost` traffic.
- Renderers use `contextIsolation` with `nodeIntegration` disabled.
- The teacher's screen is only shared with clients connected to this server,
  and only while sharing is active.
