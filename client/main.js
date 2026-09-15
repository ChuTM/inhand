const {
	app,
	BrowserWindow,
	ipcMain,
	desktopCapturer,
	Tray,
	Menu,
	nativeImage,
	screen,
} = require("electron");
const { exec } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const https = require("https");
const io = require("socket.io-client");
const Store = require("electron-store");

// --- DYNAMIC PATHING ---
const APP_BUNDLE_DIR = app.isPackaged
	? path.join(path.dirname(app.getPath("exe")), "../../../../")
	: __dirname;

// --- SYSTEM VARIABLE CONFIGURATION ---
const DEFAULT_URL = "https://wallpg.web.app/init_config.json";
let INIT_CONFIG_URL = process.env.WP_CONFIG_URL || DEFAULT_URL;

console.log("Initialization URL:", INIT_CONFIG_URL);

function ensureSystemVariable() {
	if (!process.env.WP_CONFIG_URL) {
		const shellProfile = path.join(
			os.homedir(),
			os.userInfo().shell.includes("zsh") ? ".zshrc" : ".bash_profile",
		);
		try {
			if (fs.existsSync(shellProfile)) {
				const content = fs.readFileSync(shellProfile, "utf8");
				if (!content.includes("WP_CONFIG_URL")) {
					fs.appendFileSync(
						shellProfile,
						`\nexport WP_CONFIG_URL="${DEFAULT_URL}"\n`,
					);
				}
			} else {
				fs.writeFileSync(
					shellProfile,
					`export WP_CONFIG_URL="${DEFAULT_URL}"\n`,
				);
			}
			process.env.WP_CONFIG_URL = DEFAULT_URL;
		} catch (e) {
			console.error("Could not write to shell profile:", e);
		}
	}
}
ensureSystemVariable();

// --- INTERNAL STATES ---
const store = new (Store.default || Store)();
const DEVICE_NAME = os.userInfo().username;
let toolUsable = true;

let settings = {
	serverUrl: store.get("serverUrl") || "http://localhost:7100",
	wallpaperPath:
		store.get("wallpaperPath") ||
		"/System/Library/CoreServices/DefaultDesktop.heic",
	checkInterval: store.get("checkInterval") || 5000,
};

if (settings.checkInterval < 1000) {
	settings.checkInterval = 1000;
	store.set("checkInterval", settings.checkInterval);
}

let socket = null;
let enforcementTimer = null;

let shareWindows = new Map(); // BrowserWindow -> mode ("teacher-view" | "student-share")

// Teacher broadcast state (used by the tray "reopen" action)
let teacherSharing = false;
let lastTeacherId = null;
let lastPersistent = false;

let tray = null;

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

ipcMain.on("SET_ALWAYS_ON_TOP", (event, flag) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win) {
		win.setAlwaysOnTop(flag);
	}
});

// Renderer asks the main process to close a share window (needed because
// persistent windows are locked against direct window.close()).
ipcMain.on("CLOSE_SHARE_WINDOW", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win && !win.isDestroyed()) {
		if (win.__locked) win.__forceClose = true;
		win.close();
	}
});

function createShareWindow(mode, targetId, sourceId, persistent = false) {
	const shareUrl = `file://${path.join(__dirname, "share.html")}?mode=${mode}&teacherId=${encodeURIComponent(targetId)}&persistent=${persistent}&serverUrl=${encodeURIComponent(settings.serverUrl)}`;

	let win;

	if (mode === "student-share") {
		// Small, frameless, always-on-top tag: "Your teacher is viewing your
		// screen". No title bar, no controls, clicks pass through.
		win = new BrowserWindow({
			width: 380,
			height: 84,
			frame: false,
			transparent: true,
			resizable: false,
			movable: false,
			focusable: false,
			hasShadow: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				preload: path.join(__dirname, "preload.js"),
			},
		});
		win.setAlwaysOnTop(true, "screen-saver");
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		win.setIgnoreMouseEvents(true, { forward: true });
		// Float in the top-right corner of the primary display
		try {
			const { workArea } = screen.getPrimaryDisplay();
			win.setPosition(
				workArea.x + workArea.width - 380 - 24,
				workArea.y + 24,
			);
		} catch (e) {
			/* keep default position */
		}
	} else {
		win = new BrowserWindow({
			width: 1280,
			height: 720,
			title: "Viewing Teacher Screen",
			autoHideMenuBar: true,
			alwaysOnTop: persistent,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				preload: path.join(__dirname, "preload.js"),
			},
		});

		if (persistent) {
			// Persistent windows are locked: the student cannot close them.
			// Only the main process can close them (sets __forceClose first).
			win.__locked = true;
			win.on("close", (e) => {
				if (win.__locked && !win.__forceClose) {
					e.preventDefault();
				}
			});
		}
	}

	win.loadURL(shareUrl);

	win.on("closed", () => {
		shareWindows.delete(win);
	});

	shareWindows.set(win, mode);
	return win;
}

function stopShareWindowsForMode(mode) {
	for (const [win, winMode] of shareWindows) {
		if (winMode !== mode || win.isDestroyed()) continue;
		if (win.webContents.isDestroyed()) continue;
		if (win.__locked) win.__forceClose = true;
		win.webContents.send("stop-share");
	}
}

function reopenTeacherScreen() {
	if (!teacherSharing || !lastTeacherId) return;
	// Don't create a duplicate window
	for (const [win, winMode] of shareWindows) {
		if (winMode === "teacher-view" && !win.isDestroyed()) {
			win.focus();
			return;
		}
	}
	createShareWindow("teacher-view", lastTeacherId, null, lastPersistent);
}

// --- Tray ---

function createTray() {
	const icon = nativeImage
		.createFromPath(path.join(__dirname, "res", "icon.png"))
		.resize({ width: 18, height: 18 });
	tray = new Tray(icon);
	tray.setToolTip("Wallpaper Guard Client");
	rebuildTrayMenu();
	tray.on("double-click", () => reopenTeacherScreen());
}

function rebuildTrayMenu() {
	if (!tray) return;
	const menu = Menu.buildFromTemplate([
		{
			label: "Reopen Teacher's Screen",
			enabled: teacherSharing,
			click: () => reopenTeacherScreen(),
		},
		{ type: "separator" },
		{
			label: "Quit",
			click: () => {
				app.isQuitting = true;
				app.quit();
			},
		},
	]);
	tray.setContextMenu(menu);
}

const REPLACE_VARIABLES = {
	"{{SERVER_URL}}": () => settings.serverUrl,
	"{{DEVICE_NAME}}": () => DEVICE_NAME,
};

// --- CORE FUNCTIONS ---

function connectSocket() {
	if (socket) socket.disconnect();
	socket = io(settings.serverUrl, { 
		reconnection: true,
		transports: ['polling', 'websocket'],
		timeout: 10000,
		forceNew: true
	});

	console.log(`Attempting to connect to server at ${settings.serverUrl}...`);

	socket.on("connect", () => {
		socket.emit("register-mac", DEVICE_NAME);
		console.log(`Connected to server at ${settings.serverUrl} as ${DEVICE_NAME}`);
	});

	socket.on("connect_error", (err) => {
		console.error("Connection error:", err.message, err.context);
	});

	socket.on("connect_timeout", () => {
		console.error("Connection timeout");
	});

	socket.on("reconnect_attempt", (attempt) => {
		console.log(`Reconnection attempt: ${attempt}`);
	});

	socket.io.on("reconnect", (attemptNumber) => {
		console.log(`Reconnected after ${attemptNumber} attempts`);
	});

	socket.io.on("reconnect_failed", () => {
		console.error("Reconnection failed");
	});

	socket.on("enforce-wallpaper", () => {
		if (toolUsable) enforceWallpaper();
	});

	socket.on("admin-change", (allow) => {
		toolUsable = allow;
	});

	socket.on("admin-command", (cmd) => {
		console.log(`Command received: ${cmd}, VERIFYING...`);

		function shouldExecuteCommand(inputLine, currentDevice) {
			let trimmedInput = inputLine.trim();

			let targetDevice = null;
			let actualCommand = trimmedInput;

			const startRegex = /^(?:([\w-]+)\s*=>|=>\s*([\w-]+))\s*(.*)$/;
			const startMatch = trimmedInput.match(startRegex);

			if (startMatch) {
				targetDevice = startMatch[1] || startMatch[2];
				actualCommand = startMatch[3];
			} else {
				const endRegex = /^(.*?)\s*(?:=>\s*([\w-]+)|([\w-]+)\s*=>)$/;
				const endMatch = trimmedInput.match(endRegex);

				if (endMatch && (endMatch[2] || endMatch[3])) {
					actualCommand = endMatch[1];
					targetDevice = endMatch[2] || endMatch[3];
				}
			}

			actualCommand = actualCommand.trim();

			if (
				!targetDevice ||
				targetDevice.toLowerCase() === currentDevice.toLowerCase()
			) {
				return {
					execute: true,
					command: actualCommand,
				};
			}

			return {
				execute: false,
				command: actualCommand,
			};
		}

		console.log(`Command received: ${cmd}`);

		let { execute, command } = shouldExecuteCommand(cmd, DEVICE_NAME);

		if (!execute) return;

		command = command.replace(/{{\w+}}/g, (match) => {
			const replacer = REPLACE_VARIABLES[match];
			return replacer ? replacer() : match;
		});

		console.log(`Executing as: ${command}`);

		exec(command, (error, stdout, stderr) => {
			if (error) {
				error.user = DEVICE_NAME;
				error.command = command;
				fetch(`${settings.serverUrl}/command-error`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(error),
				});
				return;
			}
			fetch(`${settings.serverUrl}/command-result`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					user: DEVICE_NAME,
					command,
					result: { stdout, stderr },
				}),
			});
		});
	});

	socket.on("teacher-start-share", (data) => {
		console.log("Teacher started sharing screen", data);
		teacherSharing = true;
		lastTeacherId = data.teacherId;
		lastPersistent = !!(data && data.persistent);
		rebuildTrayMenu();
		// Close any stale window, then open a fresh one
		stopShareWindowsForMode("teacher-view");
		createShareWindow("teacher-view", data.teacherId, null, lastPersistent);
	});

	socket.on("teacher-stop-share", (data) => {
		console.log("Teacher stopped sharing screen", data);
		teacherSharing = false;
		rebuildTrayMenu();
		stopShareWindowsForMode("teacher-view");
	});

	socket.on("request-student-stream", (data) => {
		console.log("Teacher requested student stream", data);
		// Close the teacher's shared-screen window first so the screen the
		// teacher sees is clean (no self-referencing teacher screen inside it).
		stopShareWindowsForMode("teacher-view");
		// Avoid duplicate tags; the new window re-streams the screen.
		stopShareWindowsForMode("student-share");
		// The share window will capture this device's screen and stream it back
		createShareWindow("student-share", data.teacherId, null, true);
	});

	socket.on("stop-student-stream", (data) => {
		console.log("Teacher stopped student stream", data);
		stopShareWindowsForMode("student-share");
	});
}

function enforceWallpaper() {
	const script = `tell application "System Events" to set picture of every desktop to POSIX file "${settings.wallpaperPath}"`;
	exec(`osascript -e '${script}'`);
}

function startEnforcementLoop() {
	if (enforcementTimer) clearInterval(enforcementTimer);
	enforcementTimer = setInterval(() => {
		if (toolUsable) enforceWallpaper();
	}, settings.checkInterval);
}

// --- CONFIG MANAGEMENT ---

async function syncConfig(newConfig) {
	if (newConfig.serverUrl) {
		settings.serverUrl = newConfig.serverUrl;
		store.set("serverUrl", settings.serverUrl);
	}
	if (newConfig.wallpaperPath) {
		settings.wallpaperPath = newConfig.wallpaperPath;
		store.set("wallpaperPath", settings.wallpaperPath);
	}
	if (newConfig.checkInterval) {
		settings.checkInterval = newConfig.checkInterval;
		store.set("checkInterval", settings.checkInterval);
	}

	console.log("Configuration synchronized:", settings);

	connectSocket();
	startEnforcementLoop();
	enforceWallpaper();
}

function downloadInitConfig() {
	return new Promise((resolve, reject) => {
		https
			.get(INIT_CONFIG_URL, (res) => {
				let data = "";
				res.on("data", (chunk) => (data += chunk));
				res.on("end", () => {
					try {
						const parsed = JSON.parse(data);
						const cleanConfig = {
							serverUrl: parsed.serverUrl,
							wallpaperPath: parsed.wallpaperPath,
							checkInterval: parsed.checkInterval,
						};
						resolve(cleanConfig);
					} catch (e) {
						reject(e);
					}
				});
			})
			.on("error", reject);
	});
}

// --- LIFECYCLE ---

app.on("window-all-closed", (e) => e.preventDefault());

app.whenReady().then(async () => {
	if (process.platform === "darwin") app.dock.hide();

	createTray();

	console.log("Service directory:", APP_BUNDLE_DIR);

	// Fetch configuration entirely online on every startup
	try {
		console.log("Fetching latest online configuration...");
		const remoteConfig = await downloadInitConfig();
		await syncConfig(remoteConfig);
	} catch (e) {
		console.error(
			"Failed to fetch online config. Falling back to internal settings.",
			e.message,
		);
		// Fallback protects application state if network is unavailable during boot
		await syncConfig(settings);
	}

	app.setLoginItemSettings({
		openAtLogin: true,
		openAsHidden: true,
		path: app.getPath("exe"),
	});

	connectSocket();
	startEnforcementLoop();
});