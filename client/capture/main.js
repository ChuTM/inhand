// InHand Capture — screen-capture helper (LSUIElement).
//
// Owns the macOS Screen Recording grant. A hidden renderer grabs the desktop
// via desktopCapturer + getUserMedia, JPEG-encodes frames, and ships them
// over IPC to this process, which pushes them to any local WebSocket client
// (the main InHand Student app's share windows) on 127.0.0.1:7931/frames.
//
// The main app is updated freely; this helper is root-owned under
// /Library/Application Support/InHand and is updated almost never, so the
// one-time Screen Recording grant stays valid.

const { app, BrowserWindow, desktopCapturer, ipcMain } = require("electron");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");

const HOST = "127.0.0.1";
const PORT = 7931;
const WS_PATH = "/frames";

let hiddenWin = null;
const frameClients = new Set();
let frameCounter = 0;
let lastFrameAt = 0;

// --- Local WebSocket server: pushes JPEG frames to the main app ------------
const server = http.createServer();
const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on("connection", (ws, req) => {
	// Only loopback: refuse any non-local peer.
	const addr = req.socket.remoteAddress || "";
	if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
		ws.close(1008, "loopback only");
		return;
	}
	frameClients.add(ws);
	ws.on("close", () => frameClients.delete(ws));
	ws.on("error", () => frameClients.delete(ws));
	console.log("[capture] frame client connected, total", frameClients.size);
});

function broadcastFrame(jpgBuf, meta) {
	if (frameClients.size === 0) return;
	for (const c of frameClients) {
		if (c.readyState === 1) {
			try {
				c.send(jpgBuf);
			} catch {
				/* drop */
			}
		}
	}
	frameCounter++;
	if (Date.now() - lastFrameAt > 5000) {
		lastFrameAt = Date.now();
		console.log(
			`[capture] streaming ${jpgBuf.length} B/frame @ ~${(frameCounter * 1000) / 5000} fps, clients=${frameClients.size}`,
		);
		frameCounter = 0;
	}
}

// --- Hidden renderer: does the actual capture -------------------------------
function createHiddenWindow() {
	console.log("[capture] creating hidden window");
	hiddenWin = new BrowserWindow({
		show: false, // invisible helper — students must never see this window
		width: 320,
		height: 200,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
			sandbox: false,
			backgroundThrottling: false,
		},
	});
	console.log("[capture] window created, loading page");
	const mock = process.env.INHAND_CAPTURE_MOCK === "1" ? "1" : "0";
	hiddenWin.loadFile(path.join(__dirname, "capture-renderer.html"), {
		query: { mock },
	});
	hiddenWin.on("closed", () => {
		hiddenWin = null;
	});
}

// desktopCapturer is main-process-only since Electron 28; the hidden renderer
// asks here for the source id, then calls getUserMedia with it.
ipcMain.handle("GET_SCREEN_SOURCES", async () => {
	const sources = await desktopCapturer.getSources({
		types: ["screen"],
		thumbnailSize: { width: 1, height: 1 },
	});
	return sources.map((s) => ({ id: s.id, name: s.name }));
});

ipcMain.on("CAPTURE_FRAME", (_event, payload) => {
	if (!payload || !payload.jpg) return;
	broadcastFrame(Buffer.isBuffer(payload.jpg) ? payload.jpg : Buffer.from(payload.jpg));
});

ipcMain.on("CAPTURE_ERROR", (_event, message) => {
	console.error("[capture] renderer error:", message);
});

// --- Lifecycle ---------------------------------------------------------------
app.whenReady().then(() => {
	server.listen(PORT, HOST, () => {
		console.log(`[capture] frame server on ws://${HOST}:${PORT}${WS_PATH}`);
	});
	createHiddenWindow();
	app.on("activate", () => {
		if (hiddenWin === null) createHiddenWindow();
	});
});

app.on("window-all-closed", () => {
	// Stay alive as a background helper (no dock icon).
	// Only quit on explicit signal.
});

process.on("SIGTERM", () => {
	server.close();
	app.quit();
});

// Keep the helper alive even if every window closes; expose the port via a
// marker file so the main app can find us quickly.
const { existsSync, writeFileSync, mkdirSync } = require("fs");
const markerDir = "/Library/Application Support/InHand";
try {
	mkdirSync(markerDir, { recursive: true });
	writeFileSync(path.join(markerDir, "capture.port"), String(PORT), { mode: 0o644 });
} catch {
	/* dev mode: ignore */
}

// Reference desktopCapturer so bundlers/static checks keep it imported.
void desktopCapturer;
