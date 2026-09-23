const {
	app,
	BrowserWindow,
	ipcMain,
	desktopCapturer,
	nativeImage,
	screen,
} = require("electron");
const { execFile, spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const net = require("net");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const io = require("socket.io-client");
const Store = require("electron-store");
const {
	canonicalize,
	verifyPayload,
	encryptTo,
	decryptFrom,
	generateKeyPair,
	createNonceGuard,
} = require("./lib/crypto.js");

// --- DYNAMIC PATHING ---
const APP_BUNDLE_DIR = app.isPackaged
	? path.join(path.dirname(app.getPath("exe")), "../../../../")
	: __dirname;

// Native wallpaper setter (NSWorkspace API, no Automation permission needed).
// Packaged apps carry it under Contents/Resources/helper/setdesktop.
const SETDESKTOP_HELPER = app.isPackaged
	? path.join(process.resourcesPath, "helper", "setdesktop")
	: path.join(__dirname, "helper", "setdesktop");

// Health/privilege audit script (audit command). Packaged apps carry it under
// Contents/Resources/helpers/audit.sh alongside the firewall helpers.
const AUDIT_HELPER = app.isPackaged
	? path.join(process.resourcesPath, "helpers", "audit.sh")
	: path.join(__dirname, "helper", "audit.sh");

// --- CONFIG ---
const BUNDLED_CONFIG_PATH = path.join(__dirname, "config.json");
const RUNTIME_CONFIG_PATH = path.join(app.getPath("userData"), "config.json");

function readConfigFile(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

function ensureRuntimeConfig() {
	if (!fs.existsSync(RUNTIME_CONFIG_PATH)) {
		try {
			fs.copyFileSync(BUNDLED_CONFIG_PATH, RUNTIME_CONFIG_PATH);
		} catch (e) {
			console.error("Could not seed runtime config:", e);
		}
	}
}
ensureRuntimeConfig();

const bundledConfig = readConfigFile(BUNDLED_CONFIG_PATH);
const runtimeConfig = readConfigFile(RUNTIME_CONFIG_PATH);

// Priority: WP_API_URL env > runtime config > bundled config > default
const API_URL =
	process.env.WP_API_URL ||
	runtimeConfig.apiUrl ||
	"https://inhand-server.vercel.app";
const CLOUD_PUB =
	process.env.WP_CLOUD_PUB ||
	runtimeConfig.cloudPub ||
	"";

// Teacher can send `update` with method=script to run the hosted updater.
const DEFAULT_UPDATE_SCRIPT_URL = "https://ihinstall.web.app/install.sh";

// --- INTERNAL STATES ---
const store = new (Store.default || Store)();
const DEVICE_NAME = os.userInfo().username;
let toolUsable = store.get("toolUsable") !== false;

let settings = {
	serverUrl:
		store.get("serverUrl") ||
		runtimeConfig.serverUrl ||
		"http://localhost:7100",
	wallpaperPath:
		store.get("wallpaperPath") ||
		runtimeConfig.wallpaperPath ||
		"/System/Library/CoreServices/DefaultDesktop.heic",
	checkInterval: store.get("checkInterval") || runtimeConfig.checkInterval || 5000,
};

if (settings.checkInterval < 1000) {
	settings.checkInterval = 1000;
	store.set("checkInterval", settings.checkInterval);
}

let socket = null;
let enforcementTimer = null;
let discoveryRetryTimer = null;

let teacherPub = null; // { signPub, encPub } — from cloud discovery
let shareWindows = new Map(); // BrowserWindow -> mode ("teacher-view" | "student-share")

let teacherSharing = false;
let lastTeacherId = null;
let lastPersistent = false;


const nonceGuard = createNonceGuard(120000);

// --- AUDIT ---
const AUDIT_FILE = path.join(app.getPath("userData"), "audit.log");

// --- CLIENT IDENTITY (enc keypair so the teacher can encrypt secrets back) ---
const IDENTITY_FILE = path.join(app.getPath("userData"), "identity.json");
let identity = null;
function loadOrCreateIdentity() {
	try {
		if (fs.existsSync(IDENTITY_FILE)) {
			const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"));
			if (raw && raw.encPriv && raw.encPub) {
				identity = raw;
				return;
			}
		}
	} catch (e) {
		console.warn("identity corrupt, regenerating:", e.message);
	}
	identity = generateKeyPair();
	try {
		fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2), {
			mode: 0o600,
		});
	} catch (e) {
		console.warn("Could not persist identity:", e.message);
	}
}
loadOrCreateIdentity();
function audit(event, detail = {}) {
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		event,
		...detail,
	});
	try {
		fs.appendFileSync(AUDIT_FILE, line + "\n");
	} catch {
		/* best effort */
	}
	console.log("[audit]", event, JSON.stringify(detail));
}

// --- LAN GATE: privileged behavior only on private addresses ---
function isPrivateAddress(ip) {
	if (!ip) return false;
	const host = String(ip).toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return false;
	const a = Number(m[1]);
	const b = Number(m[2]);
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	return false;
}

// Apply a discovery result: update the server URL + teacher keys and (re)
// connect the signaling socket. Returns true when the server is on a private
// LAN (privileged features enabled).
async function applyDiscovery(discovery) {
	settings.serverUrl = discovery.serverUrl;
	teacherPub = discovery.teacherPub;

	// Keep the root firewall helper's teacher key in sync (overwrite on
	// mismatch). Also start the self-heal loop: the helper may be installed
	// after this discovery (install.sh -f), so retry until the daemon
	// actually holds the current teacher key.
	fwSyncTeacherKey();
	startFwKeySelfHeal();

	const host = getServerHost(settings.serverUrl);
	if (!host || !isPrivateAddress(host)) {
		// LAN gate: privileged features stay disabled on public networks.
		audit("lan-gate", { serverUrl: settings.serverUrl, host });
		console.warn(
			`[lan-gate] Server ${settings.serverUrl} is not on a private LAN; ` +
				"commands, always-on-top and screen viewing are disabled.",
		);
		return false;
	}
	if (!socket) {
		connectSocket();
	} else if (
		socket.io &&
		socket.io.uri &&
		socket.io.uri.replace(/\/+$/, "") !== settings.serverUrl.replace(/\/+$/, "")
	) {
		socket.disconnect();
		connectSocket();
	}
	return true;
}

function getServerHost(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

// --- DISCOVERY (cloud) ---
async function runDiscovery() {
	if (!API_URL) {
		console.warn("No API URL configured; using config fallback.");
		return {
			serverUrl: settings.serverUrl,
			teacherPub: null,
			source: "config",
		};
	}
	try {
		const base = API_URL.replace(/\/+$/, "");
		const res = await fetch(`${base}/api/v1/discover`, {
			signal: AbortSignal.timeout(8000),
		});
		if (res.status === 204) {
			throw new Error("No teacher registered on this public IP");
		}
		const data = await res.json();
		if (!data || !data.payload || !data.signature) {
			throw new Error("Malformed discovery response");
		}

		// Verify the cloud's signature over the base64 payload.
		const hasCloudPub =
			CLOUD_PUB && !CLOUD_PUB.startsWith("REPLACE_");
		if (hasCloudPub) {
			if (!verifyPayload(CLOUD_PUB, data.payload, data.signature)) {
				audit("discover-signature-rejected", {});
				throw new Error("Cloud discovery signature invalid");
			}
		} else {
			console.warn(
				"cloudPub not configured (placeholder). Skipping cloud signature verification.",
			);
		}

		const payload = JSON.parse(
			Buffer.from(data.payload, "base64").toString("utf8"),
		);
		if (!payload.lanIp || !isPrivateAddress(payload.lanIp)) {
			audit("discover-lan-rejected", { lanIp: payload.lanIp });
			throw new Error("Discovery returned a non-private LAN IP");
		}
		if (payload.expiresAt && Date.now() > new Date(payload.expiresAt).getTime()) {
			throw new Error("Discovery payload expired");
		}
		if (!payload.signPub || !payload.encPub) {
			throw new Error("Discovery missing teacher public keys");
		}

		const serverUrl = `http://${payload.lanIp}:7100`;
		const pubs = { signPub: payload.signPub, encPub: payload.encPub };
		store.set("discovery", {
			serverUrl,
			teacherPub: pubs,
			expiresAt: payload.expiresAt || null,
		});
		audit("discover-ok", { lanIp: payload.lanIp, source: "cloud" });
		return { serverUrl, teacherPub: pubs, source: "cloud" };
	} catch (err) {
		console.error("Discovery failed:", err.message);
		audit("discover-failed", { message: err.message });
		// Cached discovery (re-verified each boot against the cloud when possible)
		const cached = store.get("discovery");
		if (
			cached &&
			cached.teacherPub &&
			(!cached.expiresAt || Date.now() < new Date(cached.expiresAt).getTime())
		) {
			console.warn("Falling back to cached discovery.");
			return {
				serverUrl: cached.serverUrl,
				teacherPub: cached.teacherPub,
				source: "cached",
			};
		}
		return {
			serverUrl: settings.serverUrl,
			teacherPub: null,
			source: "config",
		};
	}
}

// --- VERIFICATION ---
function isVerifiedTeacherEvent(type, env) {
	if (!teacherPub || !teacherPub.signPub) return false;
	if (!nonceGuard.check(env)) return false;
	return verifyPayload(
		teacherPub.signPub,
		canonicalize(type, env.p, env.ts, env.n),
		env.s,
	);
}

// --- IPC: renderer asks MAIN to do all crypto (keys never touch renderers) ---
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

// --- Capture helper: the screen capture lives in a separate, root-owned,
// almost-never-updated helper so the one-time Screen Recording grant survives
// main-app updates. This handler ensures it is running and returns the local
// frame-stream URL; the share renderer consumes JPEG frames over WebSocket.
const CAPTURE_HOST = "127.0.0.1";
const CAPTURE_PORT = 7931;
const CAPTURE_FRAMES_URL = `ws://${CAPTURE_HOST}:${CAPTURE_PORT}/frames`;
const CAPTURE_APP_BINARY =
	"/Library/Application Support/InHand/InHand Capture.app/Contents/MacOS/InHand Capture";
const CAPTURE_DEV_DIR = path.join(__dirname, "capture");

let captureHelperSpawnedAt = 0;

function isCaptureUp() {
	return new Promise((resolve) => {
		const sock = net.connect({ host: CAPTURE_HOST, port: CAPTURE_PORT });
		sock.on("connect", () => {
			sock.destroy();
			resolve(true);
		});
		sock.on("error", () => resolve(false));
		sock.setTimeout(800, () => {
			sock.destroy();
			resolve(false);
		});
	});
}

async function spawnCaptureHelper() {
	try {
		const isProd = fs.existsSync(CAPTURE_APP_BINARY);
		const args = isProd ? [] : [CAPTURE_DEV_DIR];
		const bin = isProd ? CAPTURE_APP_BINARY : process.execPath;
		const child = spawn(bin, args, {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
		});
		child.unref();
		captureHelperSpawnedAt = Date.now();
		console.log(`[capture-helper] spawned (${isProd ? "prod" : "dev"} binary)`);
		return true;
	} catch (err) {
		console.error("[capture-helper] spawn failed:", err.message);
		return false;
	}
}

ipcMain.handle("ENSURE_CAPTURE_HELPER", async () => {
	// Already up? Return the URL immediately.
	if (await isCaptureUp()) return CAPTURE_FRAMES_URL;
	// Avoid spawning repeatedly in a tight loop.
	if (Date.now() - captureHelperSpawnedAt < 15000) return null;
	await spawnCaptureHelper();
	// Wait up to ~6 s for the helper to come up.
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 200));
		if (await isCaptureUp()) return CAPTURE_FRAMES_URL;
	}
	return null;
});

ipcMain.handle("ENCRYPT_FOR_TEACHER", (_event, obj) => {
	if (!teacherPub || !teacherPub.encPub) throw new Error("No teacher key");
	// RTCSessionDescription/RTCIceCandidate instances arrive as null after the
	// IPC structured clone. Fail loudly instead of forwarding a null payload.
	if (obj === null || typeof obj !== "object") {
		throw new Error("ENCRYPT_FOR_TEACHER payload was lost (pass plain {type,sdp})");
	}
	return encryptTo(teacherPub.encPub, obj);
});

ipcMain.handle("VERIFY_TEACHER_EVENT", (_event, { type, env }) => {
	return isVerifiedTeacherEvent(type, env);
});

ipcMain.on("SET_ALWAYS_ON_TOP", (event, flag) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win) {
		win.setAlwaysOnTop(flag);
	}
});

ipcMain.on("CLOSE_SHARE_WINDOW", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win && !win.isDestroyed()) {
		if (win.__locked) win.__forceClose = true;
		win.close();
	}
});

// --- SHARE WINDOWS ---
function createShareWindow(mode, targetId, sourceId, persistent = false) {
	const encPubParam = teacherPub?.encPub || "";
	const shareUrl = `file://${path.join(__dirname, "share.html")}?mode=${mode}&teacherId=${encodeURIComponent(targetId)}&persistent=${persistent}&serverUrl=${encodeURIComponent(settings.serverUrl)}&encPub=${encodeURIComponent(encPubParam)}`;

	let win;

	if (mode === "student-share") {
		// Invisible share window: it only runs the WebRTC + signaling logic.
		// The student-facing indicator is the system-level overlay pill
		// ("Screen Being Viewed") drawn by the main process, like LAN-only.
		win = new BrowserWindow({
			width: 1,
			height: 1,
			show: false,
			frame: false,
			transparent: true,
			resizable: false,
			movable: false,
			focusable: false,
			hasShadow: false,
			skipTaskbar: true,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				preload: path.join(__dirname, "preload.js"),
			},
		});
		win.setAlwaysOnTop(true, "screen-saver");
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		win.setIgnoreMouseEvents(true, { forward: true });
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
			backgroundColor: "#f5f5f7",
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				preload: path.join(__dirname, "preload.js"),
			},
		});

		if (persistent) {
			win.__locked = true;
			win.on("close", (e) => {
				if (win.__locked && !win.__forceClose) {
					e.preventDefault();
				}
			});
		}
	}

	win.loadURL(shareUrl);

	win.webContents.on("console-message", (event, level, message) => {
		console.log(`[share-window:${mode}] ${message}`);
		if (level >= 2) audit("share-window-console", { mode, message });
	});

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

// --- LAN-ONLY FIREWALL HELPER (root daemon, client/helper/daemon.mjs) ---
const FW_SOCKET = "/Library/Application Support/InHand/inhand-fw.sock";

// Latest firewall state known to this client. Reported to the host on every
// change (and on connect) so the admin's LAN-Only card shows the real state.
let lastFwState = { locked: false, since: null, deadline: null, ttlMinutes: null, keySet: false };

function reportFwState(patch) {
	if (patch && typeof patch === "object") {
		lastFwState = { ...lastFwState, ...patch };
	}
	if (socket && socket.connected) {
		socket.emit("fw-state", lastFwState);
	}
}

// --- Status overlay -----------------------------------------------------------
// A frameless, always-on-top, click-through pill drawn by THIS client (never
// the macOS Notification API — students could trace that back to the app).
// Fully TRANSPARENT window; the pill is translucent white, fully rounded,
// pinned to the very top-right corner. Text is dynamic:
//   - teacher is viewing this screen  -> "Screen Being Viewed"
//   - LAN-only lock active            -> "Restricted to LAN Only."
// No app-layer background, no icon, no dot; English copy only.
// SF Symbols via nativeImage.createMenuSymbol (Electron 44+). Returns a data
// URL, or null on older Electron so the caller falls back to a bundled SVG.
function sfSymbolDataUrl(symbolName) {
	try {
		const img = nativeImage.createMenuSymbol(symbolName);
		if (img && !img.isEmpty()) return img.toDataURL();
	} catch (e) {
		/* older Electron — fall back to SVG */
	}
	return null;
}

// SF-Symbols-style linear icons (fallback until Electron 44 is in place).
const OVERLAY_ICON_SVG = {
	airplane: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>`,
	insetRectPerson: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="4" width="19" height="13" rx="2.5"/><circle cx="12" cy="9.5" r="2.2"/><path d="M5.5 18.5c.9-2.9 3.6-4.1 6.5-4.1s5.6 1.2 6.5 4.1"/></svg>`,
};

function overlayHTML(text, iconDataUrl) {
	const icon = iconDataUrl
		? `<img class="icon" src="${iconDataUrl}" alt="">`
		: OVERLAY_ICON_SVG[text === "Screen Being Viewed" ? "insetRectPerson" : "airplane"];
	return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;}
.wrap{display:flex;align-items:center;justify-content:flex-end;height:100%;font:600 13px "SF Pro Display",-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;user-select:none;}
.pill{display:flex;align-items:center;gap:7px;background:#ffffff;border-radius:999px;padding:6px 16px;color:#1d1d1f;letter-spacing:-0.01em;white-space:nowrap;border:1px solid rgba(0,0,0,0.06);box-shadow:inset 0 0 0 0.5px rgba(255,255,255,0.9),inset 0 -2px 6px rgba(255,255,255,0.4),0 1px 2px rgba(0,0,0,0.05),0 4px 16px rgba(0,0,0,0.08),0 8px 32px rgba(0,0,0,0.06);}
.pill .icon{width:13px;height:13px;flex:none;}
.pill svg{width:13px;height:13px;flex:none;display:block;}
</style></head><body><div class="wrap"><span class="pill">${icon}${text}</span></div></body></html>`;
}

let lanOnlyOverlay = null;
// Overlay text is driven by live state: being viewed, and/or LAN-only lock.
const overlayState = { viewing: false, lanOnly: false };

function overlayText() {
	if (overlayState.viewing) return "Screen Being Viewed";
	if (overlayState.lanOnly) return "Restricted to LAN Only.";
	return null;
}

function updateOverlay() {
	const text = overlayText();
	if (!text) {
		hideLanOnlyOverlay();
		return;
	}
	showLanOnlyOverlay(text);
}

ipcMain.on("OVERLAY_VIEWING", (_e, v) => setViewing(!!v));

function setViewing(v) {
	overlayState.viewing = !!v;
	updateOverlay();
}

function showLanOnlyOverlay(text) {
	if (lanOnlyOverlay && !lanOnlyOverlay.isDestroyed()) return;
	const symbol = text === "Screen Being Viewed" ? "inset.filled.rectangle.and.person.filled" : "airplane";
	const iconDataUrl = sfSymbolDataUrl(symbol);
	try {
		const { workArea } = screen.getPrimaryDisplay();
		const W = 460;
		const H = 46;
		const M = 8; // margin from the top-right corner of the screen
		lanOnlyOverlay = new BrowserWindow({
			width: W,
			height: H,
			x: Math.round(workArea.x + workArea.width - W - M),
			y: workArea.y + M,
			transparent: true,
			backgroundColor: "#00000000",
			frame: false,
			alwaysOnTop: true,
			focusable: false,
			skipTaskbar: true,
			hasShadow: false,
			resizable: false,
			movable: false,
			fullscreenable: false,
			webPreferences: { nodeIntegration: false, contextIsolation: true },
		});
		lanOnlyOverlay.setAlwaysOnTop(true, "screen-saver");
		lanOnlyOverlay.loadURL(
			"data:text/html;charset=utf-8," + encodeURIComponent(overlayHTML(text, iconDataUrl)),
		);
		// Click-through: the strip never blocks clicks on anything underneath.
		lanOnlyOverlay.setIgnoreMouseEvents(true, { forward: true });
	} catch (e) {
		audit("lan-only-overlay-error", { message: e.message });
	}
}

function hideLanOnlyOverlay() {
	if (lanOnlyOverlay && !lanOnlyOverlay.isDestroyed()) lanOnlyOverlay.destroy();
	lanOnlyOverlay = null;
}

function syncLanOnlyOverlay(locked) {
	overlayState.lanOnly = !!locked;
	updateOverlay();
}

/**
 * Send a single-line JSON request to the firewall helper and await its reply.
 * Resolves { ok } from the daemon; rejects on transport/absence of the helper.
 */
function fwDaemonRequest(op, payload = {}, timeoutMs = 4000) {
	return new Promise((resolve, reject) => {
		const sock = net.connect(FW_SOCKET);
		let out = "";
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("firewall helper timeout"));
		}, timeoutMs);
		sock.setEncoding("utf8");
		sock.on("connect", () => {
			sock.write(JSON.stringify({ op, ...payload }) + "\n");
		});
		sock.on("data", (chunk) => {
			out += chunk;
			const idx = out.indexOf("\n");
			if (idx === -1) return;
			clearTimeout(timer);
			sock.destroy();
			try {
				resolve(JSON.parse(out.slice(0, idx)));
			} catch {
				reject(new Error("firewall helper bad response"));
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(
				new Error(
					"firewall helper not available (install it with: install.sh -f)",
				),
			);
		});
	});
}

/** Keep the daemon's teacher key in sync with discovery (overwrite on mismatch). */
let teacherKeyMismatch = false;

function pubFingerprint(pubB64) {
	return crypto.createHash("sha256").update(pubB64).digest("hex").slice(0, 16);
}

async function fwSyncTeacherKey() {
	if (!teacherPub?.signPub) return;
	try {
		const res = await fwDaemonRequest("status");
		if (!res.ok) return; // helper not installed (yet)
		const teacherFp = pubFingerprint(teacherPub.signPub);
		const daemonFp = res.keyFingerprint || null;
		const mismatch = res.keySet && daemonFp && daemonFp !== teacherFp;
		if (!res.keySet || mismatch) {
			// The daemon accepts key overwrites (a student who can swap keys
			// themselves is not worth fighting — unlock still requires a valid
			// teacher signature), so a rotated teacher key is re-pushed here
			// automatically. res.keyFingerprint may be absent on older
			// installed helpers; skip the overwrite then rather than guessing.
			const set = await fwDaemonRequest("setkey", {
				signPub: teacherPub.signPub,
			});
			audit("fw-setkey", {
				ok: !!set.ok,
				rotated: !!mismatch,
				daemon: daemonFp,
				teacher: teacherFp,
			});
			teacherKeyMismatch = false;
			return;
		}
		teacherKeyMismatch = false;
	} catch (e) {
		audit("fw-setkey-skip", { message: e.message });
	}
}

// --- FW KEY SELF-HEAL ----------------------------------------------------------
// The firewall helper is optional and may be installed AFTER the client's first
// discovery (install.sh -f runs near the end of installation), so the one-shot
// fwSyncTeacherKey() can miss it. Retry pushing the teacher key periodically
// until the daemon's key matches discovery; overwrite it when the teacher has
// rotated (daemon.setkey now allows replacing the key).
const FW_KEY_RETRY_MS = 15000;
let fwKeyTimer = null;

function startFwKeySelfHeal() {
	if (fwKeyTimer) return;
	fwKeyTimer = setInterval(async () => {
		if (!teacherPub?.signPub) return;
		try {
			const res = await fwDaemonRequest("status");
			if (!res.ok) return; // helper not installed (yet) — keep retrying
			const teacherFp = pubFingerprint(teacherPub.signPub);
			const daemonFp = res.keyFingerprint || null;
			const mismatch = res.keySet && daemonFp && daemonFp !== teacherFp;
			if (!res.keySet || mismatch) {
				const set = await fwDaemonRequest("setkey", {
					signPub: teacherPub.signPub,
				});
				audit("fw-setkey", {
					ok: !!set.ok,
					rotated: !!mismatch,
					daemon: daemonFp,
					teacher: teacherFp,
				});
				if (!set.ok) return; // keep retrying on failure
			}
			teacherKeyMismatch = false;
			if (fwKeyTimer) {
				clearInterval(fwKeyTimer);
				fwKeyTimer = null;
			}
		} catch {
			/* helper not installed yet — keep retrying */
		}
	}, FW_KEY_RETRY_MS);
}

// --- ONLINE HEARTBEAT -----------------------------------------------------------
// The client re-announces itself every HEARTBEAT_MS while connected, so a host
// that starts AFTER this client sees it online within one heartbeat — even if
// a re-connect event was missed. Each beat is one small ECIES-encrypted
// message; the host treats repeats as idempotent refreshes.
const HEARTBEAT_MS = 3000;
let heartbeatTimer = null;

function registerWithTeacher() {
	if (!teacherPub?.encPub) {
		console.warn("No teacher key; skipping device registration.");
		return;
	}
	try {
		socket.emit("register-mac", {
			enc: encryptTo(teacherPub.encPub, {
				name: DEVICE_NAME,
				hostname: os.hostname(),
				encPub: identity?.encPub || null,
			}),
		});
	} catch (e) {
		console.error("Registration failed:", e.message);
	}
}

// --- COMMAND WHITELIST ---
function loadCommandWhitelist() {
	const candidates = [
		path.join(__dirname, "commands.json"),
		path.join(__dirname, "..", "shared", "commands.json"),
	];
	for (const file of candidates) {
		try {
			return JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			/* try next */
		}
	}
	return { version: 0, commands: {} };
}

function validateCommand(cmd) {
	const whitelist = loadCommandWhitelist();
	if (!cmd || typeof cmd !== "object") {
		return { ok: false, reason: "command must be an object" };
	}
	const def = whitelist.commands[cmd.type];
	if (!def) return { ok: false, reason: `unknown command type: ${cmd.type}` };
	for (const [key, spec] of Object.entries(def.params || {})) {
		if (spec.required && cmd.params?.[key] === undefined) {
			return { ok: false, reason: `missing required param: ${key}` };
		}
		if (
			cmd.params?.[key] !== undefined &&
			typeof cmd.params[key] !== spec.type
		) {
			return { ok: false, reason: `param ${key} must be ${spec.type}` };
		}
	}
	return { ok: true };
}

// --- RESULT REPORTING (ECIES-encrypted) ---
async function reportResult(command, result) {
	if (!teacherPub?.encPub) return;
	try {
		const envelope = encryptTo(teacherPub.encPub, {
			user: DEVICE_NAME,
			command,
			result,
		});
		await fetch(`${settings.serverUrl}/command-result`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enc: true, ...envelope }),
		});
	} catch (e) {
		console.error("Failed to report command result:", e.message);
	}
}

async function reportError(command, error) {
	if (!teacherPub?.encPub) return;
	try {
		const envelope = encryptTo(teacherPub.encPub, {
			deviceName: DEVICE_NAME,
			command,
			message: error.message || String(error),
		});
		await fetch(`${settings.serverUrl}/command-error`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enc: true, ...envelope }),
		});
	} catch (e) {
		console.error("Failed to report command error:", e.message);
	}
}

// --- WHITELISTED COMMAND EXECUTION (no free shell) ---
// `env` is the original teacher-signed envelope; lan-only re-forwards it to
// the root firewall helper so the daemon can verify the signature itself.
function executeCommand(cmd, env) {
	const verdict = validateCommand(cmd);
	if (!verdict.ok) {
		audit("command-rejected", { reason: verdict.reason });
		reportError(cmd, new Error(verdict.reason));
		return;
	}
	audit("command-received", { type: cmd.type, params: cmd.params });

	switch (cmd.type) {
		case "wallpaper": {
			let wallpaperPath = String(cmd.params.path);
			const isUrl = /^https?:\/\//i.test(wallpaperPath);
			if (
				(!isUrl && !wallpaperPath.startsWith("/")) ||
				wallpaperPath.includes("'") ||
				wallpaperPath.includes('"') ||
				wallpaperPath.includes("\n") ||
				wallpaperPath.length > 512
			) {
				const msg = "wallpaper path rejected (must be an absolute POSIX path or http(s) URL)";
				audit("wallpaper-rejected", { path: wallpaperPath });
				reportError(cmd, new Error(msg));
				return;
			}
			const finalize = (localPath) => {
				settings.wallpaperPath = localPath;
				store.set("wallpaperPath", localPath);
				applyWallpaper(localPath, (error, stdout, stderr) => {
					if (error) {
						reportError(cmd, error);
						return;
					}
					reportResult(cmd, { stdout: stdout || "wallpaper set", stderr });
				});
			};
			if (isUrl) {
				downloadWallpaper(wallpaperPath)
					.then(finalize)
					.catch((err) => {
						audit("wallpaper-download-failed", { url: wallpaperPath, error: err.message });
						reportError(cmd, err);
					});
			} else {
				finalize(wallpaperPath);
			}
			break;
		}
		case "configMode": {
			toolUsable = !!cmd.params.on;
			store.set("toolUsable", toolUsable);
			audit("config-mode", { on: toolUsable });
			reportResult(cmd, {
				stdout: `config mode ${toolUsable ? "enabled" : "disabled"}`,
				stderr: "",
			});
			break;
		}
		case "update": {
			const method = cmd.params.method === "script" ? "script" : "zip";
			if (method === "script") {
				// Execute the hosted update script (e.g. install_update.sh).
				const scriptUrl = String(
					cmd.params.scriptUrl || DEFAULT_UPDATE_SCRIPT_URL,
				);
				if (!scriptUrl.startsWith("https://")) {
					reportError(cmd, new Error("update script URL must be HTTPS"));
					return;
				}
				const scriptSha = cmd.params.scriptSha256
					? String(cmd.params.scriptSha256)
					: "";
				if (scriptSha && !/^[a-f0-9]{64}$/i.test(scriptSha)) {
					reportError(
						cmd,
						new Error("update scriptSha256 must be 64 hex chars"),
					);
					return;
				}
				reportResult(cmd, { stdout: "update script started", stderr: "" });
				runUpdateScript(scriptUrl, scriptSha);
				break;
			}
			const url = String(cmd.params.url);
			const sha256 = String(cmd.params.sha256);
			if (!url.startsWith("https://")) {
				reportError(cmd, new Error("update URL must be HTTPS"));
				return;
			}
			if (!/^[a-f0-9]{64}$/i.test(sha256)) {
				reportError(cmd, new Error("update sha256 must be 64 hex chars"));
				return;
			}
			reportResult(cmd, { stdout: "update started", stderr: "" });
			runSelfUpdate(url, sha256);
			break;
		}
		case "lan-only": {
			if (!env) {
				reportError(cmd, new Error("lan-only requires the signed envelope"));
				break;
			}
			const on = !!cmd.params.on;
			const ttl = cmd.params.ttl;
			// The daemon re-verifies the teacher's signature against its own copy
			// of the teacher key. If that key is missing (e.g. the firewall helper
			// was installed after the client last completed discovery), sync it
			// once before forwarding so a healthy setup self-heals.
			(async () => {
				await fwSyncTeacherKey();
				return fwDaemonRequest("forward", { evt: env });
			})()
				.then((res) => {
					if (!res.ok) {
						audit("lan-only-failed", { reason: res.error });
						let msg = res.error || "firewall helper rejected";
						if (String(res.error || "").startsWith("no-key-set")) {
							msg =
								"no-key-set: the firewall helper has no teacher key yet — it syncs automatically on the next discovery (check the client's cloud connectivity), or run once: sudo sh /Library/Application Support/InHand/inhand-fwctl setkey <pub>";
						} else if (teacherKeyMismatch) {
							msg =
								"teacher-key-mismatch: the firewall helper still holds an older teacher key (auto re-sync failed — check that the helper is running), so it rejected the signature. It will retry automatically on the next discovery; if it keeps failing, update once with: sudo sh /Library/Application Support/InHand/inhand-fwctl setkey <teacher-public-key>.";
						}
						reportError(cmd, new Error(msg));
						return;
					}
					audit("lan-only", {
						on,
						ttlMinutes: res.ttlMinutes,
						deadline: res.deadline,
					});
					reportFwState({
						locked: on,
						since: on ? Date.now() : null,
						deadline: on ? res.deadline : null,
						ttlMinutes: on ? res.ttlMinutes : null,
					});
					syncLanOnlyOverlay(on);
					reportResult(cmd, {
						stdout: on
							? `LAN-only enabled (auto-release ${res.ttlMinutes}m, until ${new Date(
									res.deadline,
								).toLocaleTimeString()})`
							: "LAN-only disabled",
						stderr: "",
					});
				})
				.catch((e) => {
					audit("lan-only-error", { message: e.message });
					reportError(cmd, e);
				});
			break;
		}
		case "fw-status": {
			fwDaemonRequest("status")
				.then((res) => {
					audit("fw-status", { locked: !!res.locked });
					reportFwState({
						locked: !!res.locked,
						since: res.since,
						deadline: res.deadline,
						ttlMinutes: res.ttlMinutes,
						keySet: !!res.keySet,
					});
					syncLanOnlyOverlay(!!res.locked);
					reportResult(cmd, {
						stdout: JSON.stringify(
							{
								locked: !!res.locked,
								since: res.since,
								deadline: res.deadline,
								ttlMinutes: res.ttlMinutes,
								keySet: !!res.keySet,
								helper: "installed",
							},
							null,
							2,
						),
						stderr: "",
					});
				})
				.catch((e) => {
					audit("fw-status-error", { message: e.message });
					reportError(cmd, e);
				});
			break;
		}
		case "restart": {
			audit("restart-requested", {});
			setTimeout(() => {
				app.relaunch();
				app.exit(0);
			}, 250);
			break;
		}
		case "audit": {
			const fix = !!cmd.params.fix;
			const runAudit = (scriptPath) => {
				const args = [scriptPath];
				if (fix) args.push("-f");
				execFile("/bin/sh", args, { timeout: 60000 }, (err, stdout, stderr) => {
					audit("audit", { fix, ok: !err, via: scriptPath });
					if (err) {
						reportError(cmd, new Error(stderr || err.message || "audit failed"));
						return;
					}
					reportResult(cmd, { stdout: stdout || "audit complete", stderr });
				});
			};
			// The audit script is distributed live from ihinstall.web.app (like
			// install.sh) so it is always current without a client re-release.
			// When the machine is offline (e.g. during a LAN-only lock) fall back
			// to the bundled copy under Contents/Resources/helpers/audit.sh.
			const tmp = path.join(os.tmpdir(), `inhand-audit-${Date.now()}.sh`);
			httpsDownload("https://ihinstall.web.app/audit.sh", tmp)
				.then(() => runAudit(tmp))
				.catch(() => {
					try {
						fs.unlinkSync(tmp);
					} catch {
						/* already gone */
					}
					if (fs.existsSync(AUDIT_HELPER)) {
						runAudit(AUDIT_HELPER);
					} else {
						reportError(
							cmd,
							new Error("audit.sh unavailable (offline and not bundled)"),
						);
					}
				});
			break;
		}
		default:
			reportError(cmd, new Error(`unhandled whitelisted type: ${cmd.type}`));
	}
}

// --- SELF-UPDATE PIPELINE ---
function sha256File(file) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		const stream = fs.createReadStream(file);
		stream.on("data", (d) => hash.update(d));
		stream.on("end", () => resolve(hash.digest("hex")));
		stream.on("error", reject);
	});
}

function httpsDownload(url, dest) {
	return new Promise((resolve, reject) => {
		const out = fs.createWriteStream(dest);
		https
			.get(url, (res) => {
				if (res.statusCode !== 200) {
					reject(new Error(`download status ${res.statusCode}`));
					res.resume();
					return;
				}
				res.pipe(out);
			})
			.on("error", reject);
		out.on("finish", () => out.close(() => resolve(dest)));
		out.on("error", reject);
	});
}

// Ask the teacher (host) for this machine's admin password from the password
// book. The host replies with a signed + ECIES-encrypted envelope that only
// this client's identity key can decrypt.
function requestSudoPassword() {
	return new Promise((resolve, reject) => {
		if (!teacherPub?.signPub || !identity?.encPriv) {
			reject(new Error("no teacher key or client identity"));
			return;
		}
		const timer = setTimeout(
			() => reject(new Error("no credential reply from host (timeout)")),
			10000,
		);
		const onAck = (env) => {
			if (!env) return;
			try {
				if (!isVerifiedTeacherEvent("credential-ack", env)) {
					reject(new Error("credential reply signature invalid"));
					return;
				}
				const dec = JSON.parse(decryptFrom(identity.encPriv, env.enc));
				if (typeof dec.password !== "string" || !dec.password) {
					reject(new Error("empty credential reply"));
					return;
				}
				clearTimeout(timer);
				socket.off("credential-ack", onAck);
				resolve(dec.password);
			} catch (e) {
				reject(e);
			}
		};
		socket.on("credential-ack", onAck);
		socket.emit("credential-request", {
			hostname: os.hostname(),
			encPub: identity.encPub,
		});
	});
}

// Download and execute the hosted update script. The script itself swaps the
// .app and restarts the client, so the process may die mid-run — that is
// expected; the teacher sees the client come back online on the new version.
async function runUpdateScript(url, expectedSha256) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-updscript-"));
	const scriptPath = path.join(tmpDir, "install_update.sh");
	try {
		await httpsDownload(url, scriptPath);
		if (expectedSha256) {
			const actual = await sha256File(scriptPath);
			if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
				throw new Error("update script SHA-256 mismatch");
			}
		}
		audit("update-script-start", { url });
		// install.sh's update/install flow requires sudo; fetch the machine's
		// password from the teacher's password book and pipe it to sudo -S.
		// The password is passed via env (not argv) and never persisted.
		let sudoPass = null;
		try {
			sudoPass = await requestSudoPassword();
		} catch (e) {
			// Without a password the script can still run its non-sudo parts;
			// require_sudo inside install.sh will abort if sudo is truly needed.
			console.warn("No password from host, running without sudo:", e.message);
		}
		await new Promise((resolve, reject) => {
			// -v runs install.sh in its built-in update mode (kill -> install -> restart).
			const env = { ...process.env };
			let argv = ["-c", `zsh ${JSON.stringify(scriptPath)} -v`];
			if (sudoPass) {
				env.INHAND_SUDO_PW = sudoPass;
				argv = ["-c", `printf '%s\n' "$INHAND_SUDO_PW" | sudo -S -p '' /bin/zsh ${JSON.stringify(scriptPath)} -v`];
			}
			const child = execFile("/bin/zsh", argv, { env }, (err) =>
				err ? reject(err) : resolve(),
			);
			child.stdout?.on("data", (d) => reportResult({ type: "update" }, { stdout: d.toString(), stderr: "" }));
			child.stderr?.on("data", (d) => reportResult({ type: "update" }, { stdout: "", stderr: d.toString() }));
		});
		audit("update-script-done", { url });
	} catch (e) {
		audit("update-script-failed", { message: e.message });
		reportError({ type: "update" }, e);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

async function runSelfUpdate(url, expectedSha256) {
	audit("update-start", { url });
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-update-"));
	const archive = path.join(tmpDir, "update.zip");
	try {
		await httpsDownload(url, archive);
		const actual = await sha256File(archive);
		if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
			throw new Error("SHA-256 mismatch; update aborted");
		}
		const extracted = path.join(tmpDir, "extracted");
		fs.mkdirSync(extracted);
		await new Promise((resolve, reject) => {
			execFile(
				"ditto",
				["-x", "-k", archive, extracted],
				(err) => (err ? reject(err) : resolve()),
			);
		});
		const newApp = fs
			.readdirSync(extracted)
			.map((f) => path.join(extracted, f))
			.find((f) => f.endsWith(".app"));
		if (!newApp) throw new Error("No .app found in update archive");

		// Integrity: codesign + Gatekeeper
		await new Promise((resolve, reject) => {
			execFile(
				"codesign",
				["--verify", "--deep", "--strict", newApp],
				(err) => (err ? reject(new Error("codesign verify failed")) : resolve()),
			);
		});
		await new Promise((resolve, reject) => {
			execFile(
				"spctl",
				["--assess", "--type", "execute", newApp],
				(err) => (err ? reject(new Error("Gatekeeper assessment failed")) : resolve()),
			);
		});

		// Atomically swap the running .app
		const exePath = app.getPath("exe");
		const appRoot = path.resolve(exePath, "..", "..", "..");
		const backup = `${appRoot}.old-${Date.now()}`;
		fs.renameSync(appRoot, backup);
		try {
			fs.renameSync(newApp, appRoot);
		} catch (e) {
			fs.renameSync(backup, appRoot);
			throw e;
		}
		audit("update-applied", { version: currentVersion() });
		setTimeout(() => {
			app.relaunch();
			app.exit(0);
		}, 300);
	} catch (e) {
		audit("update-failed", { message: e.message });
		reportError({ type: "update" }, e);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

function currentVersion() {
	try {
		return require(path.join(__dirname, "package.json")).version;
	} catch {
		return "0.0.0";
	}
}

// Poll the cloud for update manifests (also verifies the cloud signature).
async function pollCloudUpdate() {
	if (!API_URL || !CLOUD_PUB || CLOUD_PUB.startsWith("REPLACE_")) return;
	try {
		const base = API_URL.replace(/\/+$/, "");
		const res = await fetch(`${base}/api/v1/update`, {
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return;
		const data = await res.json();
		if (!data || !data.signature || !data.url) return;
		const manifest = JSON.stringify({
			version: data.version,
			url: data.url,
			sha256: data.sha256,
		});
		if (!verifyPayload(CLOUD_PUB, manifest, data.signature)) {
			audit("update-manifest-rejected", {});
			return;
		}
		if (data.version && data.version !== currentVersion()) {
			audit("update-manifest-accepted", { version: data.version });
			runSelfUpdate(data.url, data.sha256);
		}
	} catch (e) {
		console.error("Update poll failed:", e.message);
	}
}

// --- SOCKET ---
function connectSocket() {
	if (socket) socket.disconnect();
	socket = io(settings.serverUrl, {
		reconnection: true,
		transports: ["polling", "websocket"],
		timeout: 10000,
		forceNew: true,
	});

	console.log(`Attempting to connect to server at ${settings.serverUrl}...`);

	socket.on("connect", () => {
		console.log(
			`Connected to server at ${settings.serverUrl} as ${DEVICE_NAME}`,
		);
		registerWithTeacher();
		// Re-announce every few seconds so a late-starting host sees this client.
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = setInterval(registerWithTeacher, HEARTBEAT_MS);
		// Re-sync firewall state (and the "viewing your screen" strip) so a host
		// that started AFTER this client still shows the real LAN-only state.
		fwDaemonRequest("status")
			.then((res) => {
				reportFwState({
					locked: !!res.locked,
					since: res.since,
					deadline: res.deadline,
					ttlMinutes: res.ttlMinutes,
					keySet: !!res.keySet,
				});
				syncLanOnlyOverlay(!!res.locked);
			})
			.catch(() => {
				/* helper not installed yet — nothing to sync */
			});
	});

	socket.on("disconnect", () => {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
		// Teacher went away — no longer being viewed.
		setViewing(false);
	});

	socket.on("register-ack", (ack) => {
		// The host pushes its current teacher keys on every registration/
		// heartbeat so a rotated key reaches this client over the LAN even
		// while the internet is cut (LAN-only lock). Apply it and re-sync the
		// firewall daemon so the teacher can still unlock.
		if (!ack || typeof ack !== "object" || typeof ack.signPub !== "string") return;
		if (!teacherPub || teacherPub.signPub !== ack.signPub) {
			teacherPub = {
				signPub: ack.signPub,
				encPub:
					typeof ack.encPub === "string"
						? ack.encPub
						: teacherPub?.encPub || null,
			};
			fwSyncTeacherKey();
			startFwKeySelfHeal();
		}
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
		enforceWallpaper();
	});

	// Teacher can pause wallpaper enforcement mid-session (student free to change
	// their own desktop) or resume it. Pause is session-only: on restart the
	// enforcement loop starts again automatically (see main()).
	socket.on("wallpaper-pause", (env) => {
		if (!isVerifiedTeacherEvent("wallpaper-pause", env)) {
			audit("unauth-wp-pause", {});
			return;
		}
		if (enforcementTimer) {
			clearInterval(enforcementTimer);
			enforcementTimer = null;
		}
		console.log("[wp] enforcement paused by teacher");
		audit("wp-paused", {});
	});

	socket.on("wallpaper-resume", (env) => {
		if (!isVerifiedTeacherEvent("wallpaper-resume", env)) {
			audit("unauth-wp-resume", {});
			return;
		}
		startEnforcementLoop();
		console.log("[wp] enforcement resumed by teacher");
		audit("wp-resumed", {});
	});

	socket.on("admin-change", (allow) => {
		toolUsable = allow;
	});

	// Signed + whitelisted command channel. No free shell.
	socket.on("admin-command", (env) => {
		if (!isVerifiedTeacherEvent("admin-command", env)) {
			audit("unauth-command", {});
			return;
		}
		executeCommand(env.p.cmd, env);
	});

	socket.on("teacher-start-share", (env) => {
		if (!isVerifiedTeacherEvent("teacher-start-share", env)) {
			audit("unauth-share-start", {});
			return;
		}
		console.log("Teacher started sharing screen", env.p);
		teacherSharing = true;
		lastTeacherId = env.p.teacherId || "broadcast";
		lastPersistent = !!env.p.persistent;
		stopShareWindowsForMode("teacher-view");
		createShareWindow("teacher-view", lastTeacherId, null, lastPersistent);
	});

	socket.on("teacher-stop-share", (env) => {
		if (!isVerifiedTeacherEvent("teacher-stop-share", env)) {
			audit("unauth-share-stop", {});
			return;
		}
		console.log("Teacher stopped sharing screen", env.p);
		teacherSharing = false;
		stopShareWindowsForMode("teacher-view");
	});

	socket.on("request-student-stream", (env) => {
		if (!isVerifiedTeacherEvent("request-student-stream", env)) {
			audit("unauth-view-request", {});
			return;
		}
		console.log("Teacher requested student stream", env.p);
		stopShareWindowsForMode("teacher-view");
		stopShareWindowsForMode("student-share");
		createShareWindow("student-share", env.p.teacherId, null, true);
		// Do NOT claim "Screen Being Viewed" here: the stream may never connect.
		// The share window reports OVERLAY_VIEWING only once WebRTC is live.
	});

	socket.on("stop-student-stream", (env) => {
		if (!isVerifiedTeacherEvent("stop-student-stream", env)) {
			audit("unauth-stop-stream", {});
			return;
		}
		console.log("Teacher stopped student stream", env.p);
		stopShareWindowsForMode("student-share");
		setViewing(false);
	});
}

// Download a teacher-provided wallpaper URL to a local image file, then
// return the local path. Only image/* responses are accepted.
function downloadWallpaper(url) {
	return new Promise((resolve, reject) => {
		const mod = url.startsWith("https:") ? https : http;
		const req = mod.get(url, { timeout: 20000 }, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error("wallpaper download HTTP " + res.statusCode));
				return;
			}
			const ct = (res.headers["content-type"] || "").split(";")[0].trim();
			if (!ct.startsWith("image/")) {
				res.resume();
				reject(new Error("wallpaper URL is not an image (" + ct + ")"));
				return;
			}
			const ext = (ct.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
			const dir = path.join(app.getPath("userData"), "wallpaper");
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, `wp-${Date.now()}.${ext}`);
			const out = fs.createWriteStream(file);
			let total = 0;
			res.on("data", (chunk) => {
				total += chunk.length;
				if (total > 50 * 1024 * 1024) {
					req.destroy();
					reject(new Error("wallpaper file too large"));
				}
			});
			res.on("error", reject);
			out.on("error", reject);
			out.on("finish", () => resolve(file));
			res.pipe(out);
		});
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("wallpaper download timeout"));
		});
	});
}

// Set the desktop picture on every screen. Prefers the bundled native helper
// (no permission prompts); falls back to AppleScript System Events automation.
function applyWallpaper(wallpaperPath, cb) {
	const tryHelper = () => {
		execFile(SETDESKTOP_HELPER, [wallpaperPath], { timeout: 15000 }, (err, stdout, stderr) => {
			if (err) {
				console.warn("setdesktop helper failed, falling back to osascript:", err.message);
				tryOsascript();
				return;
			}
			cb(null, stdout, stderr);
		});
	};
	const tryOsascript = () => {
		const script = `tell application "System Events" to set picture of every desktop to POSIX file "${wallpaperPath}"`;
		execFile("osascript", ["-e", script], { timeout: 20000 }, (err, stdout, stderr) => {
			cb(err, stdout, stderr);
		});
	};
	if (!fs.existsSync(SETDESKTOP_HELPER)) {
		console.warn("[wp-debug] helper missing at", SETDESKTOP_HELPER, "- using osascript");
		tryOsascript();
		return;
	}
	console.log("[wp-debug] helper present at", SETDESKTOP_HELPER);
	tryHelper();
}

function enforceWallpaper() {
	if (!settings.wallpaperPath) return;
	applyWallpaper(settings.wallpaperPath, (err) => {
		if (err) console.error("Wallpaper enforcement failed:", err.message);
	});
}

function startEnforcementLoop() {
	if (enforcementTimer) clearInterval(enforcementTimer);
	console.log("[wp-debug] enforcement loop start, interval=", settings.checkInterval, "path=", settings.wallpaperPath, "usable=", toolUsable);
	enforcementTimer = setInterval(() => {
		enforceWallpaper();
	}, settings.checkInterval);
}

// --- LIFECYCLE ---
app.on("window-all-closed", (e) => e.preventDefault());

// Single instance: the LaunchAgent may race with other start paths.
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	main();
}

function main() {
	app.whenReady().then(async () => {
		if (process.platform === "darwin") app.dock.hide();

		console.log("Service directory:", APP_BUNDLE_DIR);
		console.log("Cloud API URL:", API_URL);

		// Discovery: find the teacher on this school's LAN, get public keys.
		const discovery = await runDiscovery();
		const lanOk = await applyDiscovery(discovery);

		// If the client boots before the teacher registers (or the teacher is
		// temporarily offline), keep retrying discovery in the background so a
		// late-starting host is picked up without a client restart.
		if (!discovery.teacherPub || !lanOk) {
			audit("discover-waiting", { source: discovery.source });
			discoveryRetryTimer = setInterval(async () => {
				const d = await runDiscovery();
				if (!d.teacherPub) return;
				clearInterval(discoveryRetryTimer);
				const ok = await applyDiscovery(d);
				audit("discover-retry-ok", { serverUrl: d.serverUrl, lanOk: ok });
			}, 20000);
		}

		startEnforcementLoop();

		// Check for cloud-published updates on boot, then every 4 hours.
		pollCloudUpdate();
		setInterval(pollCloudUpdate, 4 * 60 * 60 * 1000);
	});
}
