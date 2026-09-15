import {
	app,
	BrowserWindow,
	Tray,
	Menu,
	nativeImage,
	Notification,
	shell,
	ipcMain,
	desktopCapturer,
} from "electron";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration & Paths
let tray = null;
let mainWindow = null;
const PORT = 7100;

let allow_config = false;

const STATIC_RES_PATH = path.join(__dirname, "res");
const DATA_RES_PATH = path.join(app.getPath("userData"), "data");
const HISTORY_FILE = path.join(DATA_RES_PATH, "device_history.json");

// Ensure the writable directory exists on the user's system
if (!fs.existsSync(DATA_RES_PATH)) {
	fs.mkdirSync(DATA_RES_PATH, { recursive: true });
}

let deviceHistory = [];
const activeUsers = new Map();

const peerConnections = new Map();
const screenShareWindows = new Map();

// Teacher screen-share state (shared across sockets)
let shareActive = false;
// viewer socket id -> student main socket id (used to notify students when a teacher view window closes)
const viewerWindows = new Map();

// macOS: Hide from dock
if (process.platform === "darwin") {
	app.dock.hide();
}

// Load Persistence
if (fs.existsSync(HISTORY_FILE)) {
	try {
		deviceHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
	} catch (e) {
		console.error("Error reading history file:", e);
		deviceHistory = [];
	}
}

const saveHistory = () => {
	try {
		fs.writeFileSync(HISTORY_FILE, JSON.stringify(deviceHistory, null, 2));
	} catch (e) {
		console.error("Failed to save history:", e);
	}
};

// Screen Capture IPC Handler
ipcMain.handle("GET_SCREEN_SOURCES", async () => {
	const sources = await desktopCapturer.getSources({
		types: ["screen", "window"],
		thumbnailSize: { width: 300, height: 200 },
	});
	return sources.map((source) => ({
		id: source.id,
		name: source.name,
		thumbnail: source.thumbnail.toDataURL(),
	}));
});

// Screen Share Window Management
function createScreenShareWindow(streamUrl, title, peerId) {
	if (screenShareWindows.has(peerId)) {
		screenShareWindows.get(peerId).focus();
		return;
	}

	const win = new BrowserWindow({
		width: 1280,
		height: 720,
		title: title,
		autoHideMenuBar: true,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			preload: path.join(__dirname, "preload.js"),
		},
	});

	win.loadURL(streamUrl);
	win.on("closed", () => {
		screenShareWindows.delete(peerId);
	});

	screenShareWindows.set(peerId, win);
	return win;
}

ipcMain.on("CREATE_SHARE_WINDOW", (event, { url, title, peerId }) => {
	createScreenShareWindow(url, title, peerId);
});

ipcMain.on("SET_ALWAYS_ON_TOP", (event, flag) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win) {
		win.setAlwaysOnTop(flag);
	}
});

// Middleware: Localhost Restriction
function restrictToLocalhost(req, res, next) {
	const remoteAddress = req.socket.remoteAddress;
	const isLocalhost =
		remoteAddress === "127.0.0.1" ||
		remoteAddress === "::1" ||
		remoteAddress === "::ffff:127.0.0.1";

	if (!isLocalhost) {
		console.warn(`Blocked remote access attempt: ${remoteAddress}`);
		return res
			.status(403)
			.send("Forbidden: Admin access restricted to localhost.");
	}
	next();
}

// Express & Socket Server
const expressApp = express();
const server = http.createServer(expressApp);
const io = new Server(server, {
	cors: { origin: "*" },
	allowEIO3: true
});

io.engine.on("connection_error", (err) => {
	console.error("Engine.io connection error:", err.code, err.message, err.context);
});

expressApp.use(express.json());
expressApp.use("/admin", restrictToLocalhost);
expressApp.use("/api", restrictToLocalhost);

// Load UI from the Read-Only app bundle
expressApp.get("/admin", (req, res) => {
	res.sendFile(path.join(STATIC_RES_PATH, "admin.html"));
});

expressApp.get("/api/status", (req, res) => {
	const activeUsersArray = Array.from(activeUsers.entries()).map(([socketId, name]) => ({ socketId, name }));
	const report = deviceHistory.map((device) => {
		const activeUser = activeUsersArray.find(u => u.name === device.name);
		return {
			...device,
			status: activeUser ? "Online" : "Offline",
			socketId: activeUser ? activeUser.socketId : null,
		};
	});
	res.json(report);
});

expressApp.post("/api/control-access", (req, res) => {
	allow_config = req.body.allow_config;
	io.emit("admin-change", allow_config);

	if (allow_config && Notification.isSupported()) {
		new Notification({
			title: "Wallpaper Guard",
			body: `Config Mode has been turned on.`,
		}).show();
	}
	res.send(true);
});

expressApp.post("/api/execute-command", (req, res) => {
	const command = req.body.command;
	io.emit("admin-command", command);
	res.send(true);
});

expressApp.post("/command-error", (req, res) => {
	const error = req.body;
	// console.error(`Command error from ${error.user}:`, error);
	io.emit("admin-command-error", error);
	res.send(true);
});

expressApp.post("/command-result", (req, res) => {
	const { user, command, result } = req.body;
	// console.log(`Command result from ${user}:`, { command, result });
	io.emit("admin-command-result", { user, command, result });
	res.send(true);
});

expressApp.post("/api/remove-history", (req, res) => {
	const nameToRemove = req.body.deviceName;
	deviceHistory = deviceHistory.filter((d) => d.name !== nameToRemove);
	saveHistory();
	res.send(true);
});

// Screen share API

expressApp.get("/server", (req, res) => {
	const interfaces = os.networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name]) {
			if (iface.family === "IPv4" && !iface.internal) {
				return res.send(iface.address);
			}
		}
	}
	res.send("127.0.0.1");
});

expressApp.get("/", (req, res) => {
	res.send("Admin server is running.");
});

expressApp.use(express.static(STATIC_RES_PATH));

// Socket Logic
io.on("connection", (socket) => {
	console.log(`New connection: ${socket.id} from ${socket.handshake.address}, transport: ${socket.conn.transport.name}`);
	socket.on("register-mac", (macUsername) => {
		io.emit("admin-change", allow_config);
		activeUsers.set(socket.id, macUsername);
		const existing = deviceHistory.find((d) => d.name === macUsername);
		if (!existing) {
			deviceHistory.push({
				name: macUsername,
				firstSeen: new Date().toLocaleString(),
			});
		} else {
			existing.lastSeen = new Date().toLocaleString();
		}
		saveHistory();
		io.emit("refresh-ui");
	});

	socket.on("disconnect", () => {
		const macUsername = activeUsers.get(socket.id);
		if (macUsername) {
			activeUsers.delete(socket.id);
			io.emit("refresh-ui");
			new Notification({
				title: "Device Offline",
				body: `${macUsername} has disconnected.`,
			}).show();
		}

		// If a teacher "view student" window closes, tell the student to stop streaming
		const viewingStudent = viewerWindows.get(socket.id);
		if (viewingStudent) {
			viewerWindows.delete(socket.id);
			socket.to(viewingStudent).emit("stop-student-stream", {
				teacherId: socket.id,
			});
		}

		const peerId = Array.from(peerConnections.keys()).find(
			(key) => peerConnections.get(key).socketId === socket.id
		);
		if (peerId) {
			const pc = peerConnections.get(peerId);
			pc.close();
			peerConnections.delete(peerId);
			if (screenShareWindows.has(peerId)) {
				screenShareWindows.get(peerId).close();
			}
		}
	});

	socket.on("share-window-join", (data) => {
		// Student share windows announce themselves so we can sync current share state.
		// Teacher "view student" windows announce role: "viewer" for disconnect cleanup.
		if (data && data.role === "viewer" && data.studentId) {
			viewerWindows.set(socket.id, data.studentId);
		} else {
			socket.emit("share-active", { active: shareActive });
		}
	});

	socket.on("screen-share-offer", (data) => {
		if (data.targetId === "broadcast") {
			socket.broadcast.emit("screen-share-offer", {
				sdp: data.sdp,
				fromId: socket.id,
			});
		} else {
			socket.to(data.targetId).emit("screen-share-offer", {
				sdp: data.sdp,
				fromId: socket.id,
			});
		}
	});

	socket.on("screen-share-answer", (data) => {
		socket.to(data.targetId).emit("screen-share-answer", {
			sdp: data.sdp,
			fromId: socket.id,
		});
	});

	socket.on("screen-share-ice-candidate", (data) => {
		if (data.targetId === "broadcast") {
			socket.broadcast.emit("screen-share-ice-candidate", {
				candidate: data.candidate,
				fromId: socket.id,
			});
		} else {
			socket.to(data.targetId).emit("screen-share-ice-candidate", {
				candidate: data.candidate,
				fromId: socket.id,
			});
		}
	});

	socket.on("teacher-start-share", (data) => {
		shareActive = true;
		socket.broadcast.emit("teacher-start-share", {
			teacherId: socket.id,
			persistent: !!(data && data.persistent),
		});
	});

	socket.on("teacher-stop-share", () => {
		shareActive = false;
		socket.broadcast.emit("teacher-stop-share", { teacherId: socket.id });
	});

	socket.on("request-student-stream", (data) => {
		socket.to(data.studentId).emit("request-student-stream", {
			teacherId: socket.id,
		});
	});

	socket.on("stop-student-stream", (data) => {
		socket.to(data.studentId).emit("stop-student-stream", {
			teacherId: socket.id,
		});
	});
});

server.listen(PORT, "::", () => {
	console.log(`Server running on port ${PORT}`);
});

// Electron UI

function showWindow() {
	if (!mainWindow) {
		mainWindow = new BrowserWindow({
			width: 1000,
			height: 800,
			show: false,
			titleBarStyle: "hidden",
			titleBarOverlay: true,
			// Icon is static, so use STATIC_RES_PATH
			icon: path.join(STATIC_RES_PATH, "icon.png"),
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				preload: path.join(__dirname, "preload.js"),
			},
		});
		mainWindow.loadURL(`http://localhost:${PORT}/admin`);
		mainWindow.on("close", (e) => {
			if (!app.isQuitting) {
				e.preventDefault();
				mainWindow.hide();
			}
		});
		mainWindow.webContents.on("will-navigate", (event, url) => {
			if (url.startsWith("http:") || url.startsWith("https:")) {
				event.preventDefault();
				shell.openExternal(url);
			}
		});
		mainWindow.on("window-handle-double-click", () => {
			if (mainWindow.isMaximized()) {
				mainWindow.unmaximize();
			} else {
				mainWindow.maximize();
			}
		});
	}
	mainWindow.show();
}

function createTray() {
	const iconPath = path.join(STATIC_RES_PATH, "icon.png");
	let icon = nativeImage
		.createFromPath(iconPath)
		.resize({ width: 18, height: 18 });

	tray = new Tray(icon);
	const contextMenu = Menu.buildFromTemplate([
		{ label: "Open Admin Dashboard", click: () => showWindow() },
		{ type: "separator" },
		{
			label: "Quit",
			click: () => {
				app.isQuitting = true;
				app.quit();
			},
		},
	]);

	tray.setToolTip("Wallpaper Guard Server");
	tray.setContextMenu(contextMenu);
}

app.whenReady().then(() => {
	showWindow();
	createTray();
	function setAutoLaunch(enabled) {
		app.setLoginItemSettings({
			openAtLogin: enabled,
			openAsHidden: true,
			path: app.getPath("exe"),
		});
	}

	setAutoLaunch(true);
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
