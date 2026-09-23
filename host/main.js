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
import crypto from "crypto";
import { fileURLToPath } from "url";
import * as keyring from "./lib/keystore.mjs";
import {
	canonicalize,
	signPayload,
	verifyPayload,
	decryptFrom,
} from "./lib/crypto.mjs";
import { initAudit, audit } from "./lib/audit.mjs";
import {
	initPasswordBook,
	loadPasswordBook,
	savePasswordBook,
	parsePasswordBookText,
	serializePasswordBook,
} from "./lib/passwordbook.mjs";
import { encryptTo } from "./lib/crypto.mjs";

import "dotenv/config"; // Testing

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Real app branding in dev mode: `electron .` runs from the Electron.app
// bundle, which otherwise reports "Electron" in the menu bar and Dock.
if (process.platform === "darwin") {
	app.setName("InHand Admin");
}

// ---------------------------------------------------------------------------
// Configuration & Paths
// ---------------------------------------------------------------------------
let tray = null;
let mainWindow = null;
const PORT = 7100;

// Developer mode: launched via `npm run dev` (electron . --dev) or
// INHAND_DEV=1. Enables DevTools, verbose socket logging and an
// auto-provisioned test keyring. Never enabled in packaged builds.
const DEV_MODE =
	process.argv.includes("--dev") || process.env.INHAND_DEV === "1";

let allow_config = false;

const STATIC_RES_PATH = path.join(__dirname, "res");
const DATA_RES_PATH = path.join(app.getPath("userData"), "data");
const HISTORY_FILE = path.join(DATA_RES_PATH, "device_history.json");
const SETTINGS_FILE = path.join(DATA_RES_PATH, "settings.json");
// Packaged apps place commands.json inside the app bundle (res/), while the
// dev tree keeps it at ../shared/. Resolve whichever actually exists so the
// packaged admin's Command Composer is not left empty.
function resolveCommandsFile() {
	const candidates = [
		path.resolve(__dirname, "../shared/commands.json"),
		path.join(__dirname, "res", "commands.json"),
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) return p;
	}
	return candidates[0];
}
const COMMANDS_FILE = resolveCommandsFile();

if (!fs.existsSync(DATA_RES_PATH)) {
	fs.mkdirSync(DATA_RES_PATH, { recursive: true });
}

// ---------------------------------------------------------------------------
// Teacher settings (school name, registration token, cloud API URL)
// ---------------------------------------------------------------------------
function loadSettings() {
	try {
		return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
	} catch {
		return {};
	}
}

function saveSettings(patch) {
	const next = { ...loadSettings(), ...patch };
	try {
		fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), {
			mode: 0o600,
		});
	} catch (e) {
		console.error("Failed to save settings:", e);
	}
	return next;
}

const settings = {
	schoolName: loadSettings().schoolName || "",
	registrationToken: loadSettings().registrationToken || "",
	// Preset to the official InHand cloud discovery server; the registration
	// heartbeat normalizes the scheme (https://) before fetching.
	apiUrl: process.env.WP_API_URL || loadSettings().apiUrl || "inhand-server.vercel.app",
};

// ---------------------------------------------------------------------------
// Audit + keyring bootstrap
// ---------------------------------------------------------------------------
initAudit(DATA_RES_PATH);
keyring.initKeystore(DATA_RES_PATH);
initPasswordBook(DATA_RES_PATH);

if (DEV_MODE && !keyring.keyringExists()) {
	keyring.setup("dev-password", "Dev School", "");
	console.log("[dev] Auto-created test keyring (password: dev-password)");
}

let deviceHistory = [];
const activeUsers = new Map();
// socket.id -> { hostname, encPub, name } — lets the host encrypt secrets back
// to a specific client and match it against the password book.
const clientInfo = new Map();
// name -> last time the history file was written (heartbeat refresh throttle)
const historySavedAt = new Map();

// Latest firewall lock state reported by clients (fw-state). Drives the
// LAN-Only action card on the admin page; updated live over the socket.
let fwState = { locked: false, since: null, deadline: null, ttlMinutes: null, keySet: false };

const peerConnections = new Map();
const screenShareWindows = new Map();

let shareActive = false;
// viewer socket id -> student main socket id (used to notify students when a teacher view window closes)
const viewerWindows = new Map();
// one-time viewer claim tokens: token -> { studentId, socketId, exp }
const viewerTokens = new Map();
// anti-replay for incoming privileged events
const nonceGuard = keyring.createNonceGuard(120000);

// This is a real desktop app: it stays in the Dock (no dock.hide) and is
// reopened from the Dock via the "activate" handler below.

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

// ---------------------------------------------------------------------------
// Signed envelope helpers
// ---------------------------------------------------------------------------
function makeSignedEnvelope(type, payload) {
	if (!keyring.isUnlocked()) {
		throw new Error("Keyring locked");
	}
	const ts = Date.now();
	const nonce = crypto.randomBytes(8).toString("hex");
	const { signPriv } = keyring.requireUnlocked();
	const sig = signPayload(signPriv, canonicalize(type, payload, ts, nonce));
	return { t: type, p: payload, ts, n: nonce, s: sig };
}

function verifySignedEnvelope(type, env) {
	const pubs = keyring.getPubs();
	if (!pubs || !env || env.t !== type) return false;
	if (!nonceGuard.check(env.n, env.ts)) return false;
	return verifyPayload(
		pubs.signPub,
		canonicalize(type, env.p, env.ts, env.n),
		env.s,
	);
}

// ---------------------------------------------------------------------------
// CSRF protection for localhost /api POST endpoints
// ---------------------------------------------------------------------------
const csrfToken = crypto.randomBytes(32).toString("hex");

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

function csrfProtect(req, res, next) {
	const origin = req.headers.origin;
	if (
		origin &&
		!origin.startsWith("http://localhost:7100") &&
		!origin.startsWith("http://127.0.0.1:7100")
	) {
		return res.status(403).send("Forbidden: bad origin.");
	}
	const token = req.headers["x-csrf-token"];
	if (!token || token !== csrfToken) {
		audit("csrf-rejected", { path: req.path });
		return res.status(403).send("Forbidden: missing CSRF token.");
	}
	next();
}

// ---------------------------------------------------------------------------
// Express & Socket Server
// ---------------------------------------------------------------------------
const expressApp = express();
const server = http.createServer(expressApp);
const io = new Server(server, {
	cors: { origin: "*" },
});

io.engine.on("connection_error", (err) => {
	console.error("Engine.io connection error:", err.code, err.message, err.context);
});

expressApp.use(express.json());
expressApp.use("/admin", restrictToLocalhost);
expressApp.use("/api", restrictToLocalhost);

expressApp.get("/admin", (req, res) => {
	res.sendFile(path.join(STATIC_RES_PATH, "admin.html"));
});

expressApp.get("/password-book", restrictToLocalhost, (req, res) => {
	res.sendFile(path.join(STATIC_RES_PATH, "password-book.html"));
});

expressApp.get("/api/status", (req, res) => {
	const activeUsersArray = Array.from(activeUsers.entries()).map(
		([socketId, name]) => ({ socketId, name }),
	);
	const report = deviceHistory.map((device) => {
		const activeUser = activeUsersArray.find((u) => u.name === device.name);
		return {
			...device,
			status: activeUser ? "Online" : "Offline",
			socketId: activeUser ? activeUser.socketId : null,
		};
	});
	res.json({ devices: report, fwState });
});

expressApp.post(
	"/api/control-access",
	restrictToLocalhost,
	csrfProtect,
	(req, res) => {
		allow_config = !!req.body.allow_config;
		io.emit("admin-change", allow_config);
		audit("config-mode", { allow: allow_config });

		if (allow_config && Notification.isSupported()) {
			new Notification({
				title: "InHand",
				body: `Config Mode has been turned on.`,
			}).show();
		}
		res.send(true);
	},
);

expressApp.post(
	"/api/remove-history",
	restrictToLocalhost,
	csrfProtect,
	(req, res) => {
		const nameToRemove = req.body.deviceName;
		deviceHistory = deviceHistory.filter((d) => d.name !== nameToRemove);
		saveHistory();
		audit("remove-history", { deviceName: nameToRemove });
		res.send(true);
	},
);

// Client command results come back ECIES-encrypted so only the teacher can read them.
function decryptStudentPayload(body) {
	if (!body || body.enc !== true) throw new Error("Missing encrypted payload");
	const { encPriv } = keyring.requireUnlocked();
	return JSON.parse(decryptFrom(encPriv, body));
}

expressApp.post("/command-error", (req, res) => {
	try {
		const error = decryptStudentPayload(req.body);
		io.emit("admin-command-error", error);
		res.send(true);
	} catch (err) {
		audit("command-error-rejected", { message: err.message });
		res.status(400).send("Invalid encrypted payload");
	}
});

expressApp.post("/command-result", (req, res) => {
	try {
		const { user, command, result } = decryptStudentPayload(req.body);
		io.emit("admin-command-result", { user, command, result });
		res.send(true);
	} catch (err) {
		audit("command-result-rejected", { message: err.message });
		res.status(400).send("Invalid encrypted payload");
	}
});

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

// ---------------------------------------------------------------------------
// Cloud registration heartbeat (teacher -> officially hosted discovery API)
// ---------------------------------------------------------------------------
function lanIp() {
	const interfaces = os.networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name]) {
			if (iface.family === "IPv4" && !iface.internal) {
				return iface.address;
			}
		}
	}
	return "127.0.0.1";
}

let regTimer = null;
let lastRegisteredOkAt = 0;

function startRegistrationHeartbeat() {
	if (regTimer) clearInterval(regTimer);
	regTimer = setInterval(registerWithCloud, 60_000);
	registerWithCloud();
}

async function registerWithCloud() {
	if (!keyring.isUnlocked()) return;
	if (!settings.registrationToken || !settings.apiUrl) {
		console.warn(
			"[cloud] Skipping register: token or WP_API_URL not configured.",
		);
		return;
	}
	const pubs = keyring.getPubs();
	if (!pubs) return;
	const body = {
		token: settings.registrationToken,
		lanIp: lanIp(),
		signPub: pubs.signPub,
		encPub: pubs.encPub,
		info: { schoolName: settings.schoolName },
	};
	try {
		// settings.apiUrl is typed without a scheme ("inhand-server.vercel.app"),
		// so normalize it here — fetch() rejects scheme-less URLs.
		const raw = (settings.apiUrl || "").trim();
		const base = /^https?:\/\//i.test(raw)
			? raw.replace(/\/+$/, "")
			: `https://${raw.replace(/\/+$/, "")}`;
		const res = await fetch(`${base}/api/v1/admin/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (res.ok) {
			const now = Date.now();
			if (now - lastRegisteredOkAt > 10 * 60 * 1000) {
				audit("cloud-register-ok", { lanIp: body.lanIp });
				lastRegisteredOkAt = now;
			}
		} else {
			const detail = await res.text().catch(() => "");
			audit("cloud-register-failed", { status: res.status, detail });
		}
	} catch (e) {
		audit("cloud-register-error", { message: e.message });
	}
}

// ---------------------------------------------------------------------------
// Whitelisted command validation (host copy of shared/commands.json)
// ---------------------------------------------------------------------------
function loadCommandWhitelist() {
	try {
		return JSON.parse(fs.readFileSync(COMMANDS_FILE, "utf8"));
	} catch (e) {
		console.error("Failed to load command whitelist:", e);
		return { version: 0, commands: {} };
	}
}

function validateCommand(cmd) {
	if (!cmd || typeof cmd !== "object") {
		return { ok: false, reason: "command must be an object" };
	}
	const whitelist = loadCommandWhitelist();
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
			return {
				ok: false,
				reason: `param ${key} must be ${spec.type}`,
			};
		}
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Internal (signed) privileged handlers — also invoked by the admin UI via IPC
// ---------------------------------------------------------------------------
function handleTeacherStartShare(persistent) {
	shareActive = true;
	audit("share-start", { persistent: !!persistent });
	io.emit(
		"teacher-start-share",
		makeSignedEnvelope("teacher-start-share", {
			persistent: !!persistent,
			teacherId: "broadcast",
		}),
	);
}

function handleTeacherStopShare() {
	shareActive = false;
	audit("share-stop", {});
	io.emit("teacher-stop-share", makeSignedEnvelope("teacher-stop-share", {}));
}

function handleRequestStudentStream(studentMainId, viewerSocketId) {
	if (!activeUsers.has(studentMainId)) {
		audit("view-rejected", { studentId: studentMainId });
		return;
	}
	audit("view-student", { studentId: studentMainId });
	io
		.to(studentMainId)
		.emit(
			"request-student-stream",
			makeSignedEnvelope("request-student-stream", {
				studentId: studentMainId,
				teacherId: viewerSocketId,
			}),
		);
}

function handleStopStudentStream(studentId) {
	io
		.to(studentId)
		.emit("stop-student-stream", makeSignedEnvelope("stop-student-stream", {}));
}

function handleWhitelistedCommand(cmd) {
	const verdict = validateCommand(cmd);
	if (!verdict.ok) {
		audit("command-rejected", { reason: verdict.reason, cmd });
		return { ok: false, error: verdict.reason };
	}
	// Count reachable registered clients. The LAN-only lock can cut the
	// client↔host socket, after which io.emit silently drops the command —
	// the teacher must know the command went nowhere.
	const clientCount = activeUsers.size;
	if (clientCount === 0) {
		audit("command-no-clients", { type: cmd.type, params: cmd.params });
		return {
			ok: false,
			error:
				"No clients connected — the LAN-only lock may have cut this socket. Unlock this machine with: sudo sh /Library/Application Support/InHand/inhand-fwctl unlock",
		};
	}
	audit("command-sent", { type: cmd.type, params: cmd.params });
	io.emit("admin-command", makeSignedEnvelope("admin-command", { cmd }));
	// LAN-only is the one command with a hard visible effect on every student;
	// confirm it with a desktop notification so the teacher knows it went out.
	if (cmd.type === "lan-only" && Notification.isSupported()) {
		const on = !!cmd.params?.on;
		new Notification({
			title: "InHand",
			body: `LAN-Only Mode is ${on ? "On" : "Off"}`,
		}).show();
	}
	return { ok: true, clients: clientCount };
}

// ---------------------------------------------------------------------------
// Socket Logic
// ---------------------------------------------------------------------------

// Every socket handler runs inside a safe wrapper: a malformed payload from
// any peer (e.g. a legacy pre-rename client) must never crash the main
// process. Errors are audited and logged, and the connection stays up.
const safeOn = (socket, event, handler) => {
	socket.on(event, (...args) => {
		try {
			handler(...args);
		} catch (e) {
			const message = String((e && e.message) || e);
			audit("handler-error", { event, error: message });
			console.error(`[socket:${event}]`, e);
		}
	});
};

io.on("connection", (socket) => {
	console.log(
		`New connection: ${socket.id} from ${socket.handshake.address}, transport: ${socket.conn.transport.name}`,
	);
	audit("socket-connect", { id: socket.id });
	if (DEV_MODE) {
		socket.onAny((ev) => console.log(`[dev:socket:${socket.id}] ${ev}`));
	}
	safeOn(socket, "disconnect", () => {
		clientInfo.delete(socket.id);
		audit("socket-disconnect", { id: socket.id });
	});

	safeOn(socket, "credential-request", (payload) => {
		// A client asks for its admin password from the teacher's password book.
		// Reply is signed (teacher) + ECIES-encrypted to that client's identity.
		const info = clientInfo.get(socket.id) || {};
		const hostname = String(payload?.hostname || info.hostname || "");
		const encPub = info.encPub || payload?.encPub;
		if (!hostname || !encPub) {
			audit("credential-no-match", { hostname });
			return;
		}
		if (!keyring.isUnlocked()) {
			audit("credential-keyring-locked", {});
			return;
		}
		const entries = loadPasswordBook(keyring.getPassword());
		const password = entries[hostname];
		if (!password) {
			audit("credential-not-in-book", { hostname });
			return;
		}
		const enc = encryptTo(encPub, JSON.stringify({ password }));
		const env = makeSignedEnvelope("credential-ack", { hostname });
		audit("credential-sent", { hostname });
		socket.emit("credential-ack", { ...env, enc });
	});

	safeOn(socket, "register-mac", (payload) => {
		try {
			// Client registers with an ECIES-encrypted { name } payload.
			const { encPriv } = keyring.requireUnlocked();
			const data = JSON.parse(decryptFrom(encPriv, payload.enc));
			const macUsername = String(data.name || "");
			if (!macUsername) return;
			clientInfo.set(socket.id, {
				hostname: String(data.hostname || ""),
				encPub: typeof data.encPub === "string" ? data.encPub : null,
				name: macUsername,
			});
			// Push the current teacher keys on every registration/heartbeat so a
			// rotated key reaches clients over the LAN even while the internet is
			// cut (LAN-only lock). The client re-pushes it to its firewall daemon.
			const pubs = keyring.getPubs();
			if (pubs?.signPub) {
				socket.emit("register-ack", {
					signPub: pubs.signPub,
					encPub: pubs.encPub || null,
				});
			}
			const prev = activeUsers.get(socket.id);
			activeUsers.set(socket.id, macUsername);
			if (prev === macUsername) {
				// Periodic client heartbeat (the client re-announces every 3 s so a
				// late-starting host sees it quickly). Keep lastSeen fresh without
				// spamming UI refreshes or disk writes — throttle to once/minute.
				const existing = deviceHistory.find((d) => d.name === macUsername);
				const lastSaved = historySavedAt.get(macUsername) || 0;
				if (existing && Date.now() - lastSaved > 60_000) {
					existing.lastSeen = new Date().toLocaleString();
					historySavedAt.set(macUsername, Date.now());
					saveHistory();
				}
				return;
			}
			io.emit("admin-change", allow_config);
			audit("register-ok", { name: macUsername });
			const existing = deviceHistory.find((d) => d.name === macUsername);
			if (!existing) {
				deviceHistory.push({
					name: macUsername,
					firstSeen: new Date().toLocaleString(),
				});
			} else {
				existing.lastSeen = new Date().toLocaleString();
			}
			historySavedAt.set(macUsername, Date.now());
			saveHistory();
			io.emit("refresh-ui");
		} catch (err) {
			audit("register-rejected", { message: err.message });
		}
	});

	safeOn(socket, "disconnect", () => {
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
			handleStopStudentStream(viewingStudent);
		}

		const peerId = Array.from(peerConnections.keys()).find(
			(key) => peerConnections.get(key).socketId === socket.id,
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

	// Clients push their firewall lock state here (plain, non-sensitive: just
	// lock/unlock + deadline). Forwarded live to the admin dashboard so the
	// LAN-Only action card shows the real state, not a guess.
	safeOn(socket, "fw-state", (state) => {
		if (!state || typeof state !== "object") return;
		const next = { ...fwState, ...state };
		next.locked = !!next.locked;
		fwState = next;
		io.emit("admin-fw-state", fwState);
	});

	safeOn(socket, "share-window-join", (data) => {
		// Student share windows announce themselves so we can sync current share state.
		// Teacher "view student" windows are authorized exclusively via viewer-claim.
		socket.emit("share-active", { active: shareActive });
	});

	// Teacher "view student" windows must prove authorization with a one-time
	// token issued by the main process when the admin clicked "View Screen".
	safeOn(socket, "viewer-claim", (data) => {
		const claim = viewerTokens.get(data?.token);
		if (!claim || Date.now() > claim.exp) {
			audit("viewer-claim-rejected", {});
			return;
		}
		if (claim.studentId !== data?.studentId) {
			audit("viewer-claim-mismatch", {});
			return;
		}
		viewerTokens.delete(data.token);
		viewerWindows.set(socket.id, claim.studentId);
		socket.emit("viewer-claim-ok");
		audit("viewer-claimed", { studentId: claim.studentId });
	});

	// A student share window asks to receive the teacher's broadcast or to
	// stream its screen to a viewer. SDP is ECIES-encrypted by the student.
	safeOn(socket, "screen-share-offer", (data) => {
		try {
			const { encPriv } = keyring.requireUnlocked();
			const sdp = JSON.parse(decryptFrom(encPriv, data.sdp));
			if (data.targetId === "broadcast") {
				// Broadcast offers go to every socket EXCEPT the sender and
				// except teacher "view student" windows (they view a specific
				// student and must not have their peer connection touched).
				const targets = [];
				for (const s of io.sockets.sockets.values()) {
					if (s.id === socket.id) continue;
					if (viewerWindows.has(s.id)) continue;
					s.emit("screen-share-offer", { sdp, fromId: socket.id });
					targets.push(s.id);
				}
				audit("offer-forwarded", { from: socket.id, target: "broadcast", to: targets.join(",") });
			} else {
				socket.to(data.targetId).emit("screen-share-offer", {
					sdp,
					fromId: socket.id,
				});
				audit("offer-forwarded", { from: socket.id, target: data.targetId });
			}
		} catch (err) {
			audit("offer-rejected", { message: err.message });
		}
	});

	// Answers are teacher-originated; the server signs them on their way to students.
	safeOn(socket, "screen-share-answer", (data) => {
		try {
			socket.to(data.targetId).emit(
				"screen-share-answer",
				makeSignedEnvelope("screen-share-answer", {
					sdp: data.sdp,
					fromId: socket.id,
				}),
			);
			audit("answer-relayed", { from: socket.id, target: data.targetId });
		} catch (err) {
			audit("answer-dropped", { message: err.message });
		}
	});

	safeOn(socket, "screen-share-ice-candidate", (data) => {
		// Student -> teacher: candidate is ECIES-encrypted; decrypt and forward.
		// The envelope carries v:1 (no enc flag), so detect it by the version.
		if (data.candidate && (data.candidate.enc === true || data.candidate.v === 1)) {
			try {
				const { encPriv } = keyring.requireUnlocked();
				const candidate = JSON.parse(decryptFrom(encPriv, data.candidate));
				socket.to(data.targetId).emit("screen-share-ice-candidate", {
					candidate,
					fromId: socket.id,
				});
			} catch (err) {
				audit("ice-rejected", { message: err.message });
			}
			return;
		}
		// Teacher -> student: sign on the way out.
		try {
			socket.to(data.targetId).emit(
				"screen-share-ice-candidate",
				makeSignedEnvelope("screen-share-ice-candidate", {
					candidate: data.candidate,
					fromId: socket.id,
				}),
			);
			audit("ice-relayed", { from: "teacher", target: data.targetId });
		} catch (err) {
			audit("ice-dropped", { message: err.message });
		}
	});

	// Privileged teacher events from the network MUST be signed by the teacher's
	// private key. Anything else is rejected and audited.
	safeOn(socket, "teacher-start-share", (data) => {
		if (!verifySignedEnvelope("teacher-start-share", data)) {
			audit("unauth-teacher-event", { type: "teacher-start-share" });
			return;
		}
		handleTeacherStartShare(data.p?.persistent);
	});

	safeOn(socket, "teacher-stop-share", (data) => {
		if (!verifySignedEnvelope("teacher-stop-share", data)) {
			audit("unauth-teacher-event", { type: "teacher-stop-share" });
			return;
		}
		handleTeacherStopShare();
	});

	// A "view student" window asks the student to start streaming. The window
	// already proved authorization via viewer-claim (one-time token), so no
	// signature is needed — but it MUST map to the student it claimed.
	safeOn(socket, "request-student-stream", (data) => {
		const viewingStudent = viewerWindows.get(socket.id);
		if (!viewingStudent || viewingStudent !== data?.studentId) {
			audit("unauth-view-request", { studentId: data?.studentId });
			return;
		}
		handleRequestStudentStream(viewingStudent, socket.id);
	});
});

server.listen(PORT, "::", () => {
	console.log(`Server running on port ${PORT}`);
	if (DEV_MODE) {
		console.log("[dev] Developer mode active: DevTools on, verbose socket logs, test keyring.");
		console.log("[dev] Dashboard: http://localhost:" + PORT + "/admin");
	}
});

// ---------------------------------------------------------------------------
// IPC (admin renderer <-> main). The private key never leaves this process.
// ---------------------------------------------------------------------------
// SF Symbols for the admin UI (real macOS symbols via Electron 44+).
ipcMain.handle("SF_SYMBOL", (_event, name) => {
	const symbolName = String(name);
	// createMenuSymbol only rasterizes a tiny fixed-size template (15x13),
	// which looks blurry when scaled up. Prefer the higher-resolution
	// named-image renderer, then a 256px supersampled resize as fallback.
	try {
		const img = nativeImage.createFromNamedImage(symbolName, { width: 256, height: 256 });
		if (img && !img.isEmpty() && img.getSize().width >= 48) return img.toDataURL();
	} catch (e) {
		/* fall through */
	}
	try {
		const img = nativeImage.createMenuSymbol(symbolName).resize({ width: 256, height: 256, quality: "best" });
		if (img && !img.isEmpty()) return img.toDataURL();
	} catch (e) {
		/* no symbol available */
	}
	return null;
});

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

/** Short fingerprint of a public key (sha256, first 16 hex) — matches client/daemon. */
function keyFingerprint(pubB64) {
	if (!pubB64) return null;
	return crypto.createHash("sha256").update(pubB64).digest("hex").slice(0, 16);
}

// Settings are plaintext on disk, so never hand them to an unlocked-less
// renderer. The Settings window gates on GET_SECURITY_STATE first; these
// handlers double-check server-side so a locked window leaks nothing.
ipcMain.handle("GET_SECURITY_STATE", () => {
	const locked = !keyring.isUnlocked();
	if (locked) {
		return {
			needsSetup: !keyring.keyringExists(),
			locked: true,
			schoolName: null,
			apiUrl: null,
			registered: false,
			signPub: null,
			signFingerprint: null,
		};
	}
	const pubs = keyring.getPubs() || {};
	return {
		needsSetup: false,
		locked: false,
		schoolName: settings.schoolName,
		apiUrl: settings.apiUrl,
		registered: !!settings.registrationToken,
		signPub: pubs.signPub || null,
		signFingerprint: keyFingerprint(pubs.signPub),
	};
});

ipcMain.handle("SETUP", (_event, { password, schoolName, registrationToken }) => {
	try {
		keyring.setup(password, schoolName, registrationToken);
		const next = saveSettings({ schoolName, registrationToken });
		settings.schoolName = next.schoolName;
		settings.registrationToken = next.registrationToken;
		audit("setup", { schoolName });
		startRegistrationHeartbeat();
		return { ok: true };
	} catch (err) {
		audit("setup-failed", { message: err.message });
		return { ok: false, error: err.message };
	}
});

ipcMain.handle("UNLOCK", (_event, { password }) => {
	try {
		keyring.unlock(password);
		audit("unlock", {});
		startRegistrationHeartbeat();
		return { ok: true };
	} catch (err) {
		audit("unlock-failed", { message: err.message });
		return { ok: false, error: err.message };
	}
});

// Password book (encrypted at rest with the in-memory unlock password).
ipcMain.handle("GET_PASSWORD_BOOK", () => {
	try {
		if (!keyring.isUnlocked()) return { ok: false, error: "Keyring locked" };
		const entries = loadPasswordBook(keyring.getPassword());
		return { ok: true, entries, text: serializePasswordBook(entries) };
	} catch (err) {
		return { ok: false, error: err.message };
	}
});

ipcMain.handle("SAVE_PASSWORD_BOOK", (_event, { text }) => {
	try {
		if (!keyring.isUnlocked()) return { ok: false, error: "Keyring locked" };
		const entries = parsePasswordBookText(text || "");
		const saved = savePasswordBook(entries, keyring.getPassword());
		audit("password-book-saved", { count: Object.keys(saved).length });
		return { ok: true, entries: saved, text: serializePasswordBook(saved) };
	} catch (err) {
		return { ok: false, error: err.message };
	}
});

ipcMain.handle("ROTATE_KEYS", (_event, { password }) => {
	try {
		const before = keyring.getPubs() || {};
		const { pubs } = keyring.rotateKeys(password);
		audit("keys-rotated", {});
		startRegistrationHeartbeat();
		return {
			ok: true,
			pubs,
			oldFingerprint: keyFingerprint(before.signPub),
			newFingerprint: keyFingerprint(pubs.signPub),
		};
	} catch (err) {
		audit("rotate-failed", { message: err.message });
		return { ok: false, error: err.message };
	}
});

ipcMain.handle("CHANGE_PASSWORD", (_event, { oldPassword, newPassword }) => {
	try {
		keyring.changePassword(oldPassword, newPassword);
		audit("password-changed", {});
		return { ok: true };
	} catch (err) {
		audit("password-change-failed", { message: err.message });
		return { ok: false, error: err.message };
	}
});

ipcMain.handle("GET_CSRF", () => csrfToken);

ipcMain.handle("GET_SETTINGS", () => {
	if (!keyring.isUnlocked()) return { locked: true };
	return { ...settings };
});

ipcMain.handle("SET_SETTINGS", (_event, patch) => {
	if (!keyring.isUnlocked()) return { ok: false, error: "locked" };
	const safe = {};
	if (typeof patch.schoolName === "string") safe.schoolName = patch.schoolName;
	if (typeof patch.registrationToken === "string")
		safe.registrationToken = patch.registrationToken;
	if (typeof patch.apiUrl === "string") safe.apiUrl = patch.apiUrl;
	const next = saveSettings(safe);
	Object.assign(settings, next);
	audit("settings-updated", { keys: Object.keys(safe) });
	startRegistrationHeartbeat();
	return { ok: true, settings: { ...settings } };
});

ipcMain.handle("GET_COMMAND_WHITELIST", () => loadCommandWhitelist());

// Privileged teacher actions from the admin UI. The renderer never signs;
// it submits an intent and main signs + emits.
ipcMain.handle("SEND_TEACHER_EVENT", (_event, { type, payload }) => {
	try {
		if (!keyring.isUnlocked()) {
			return { ok: false, error: "Keyring locked" };
		}
		switch (type) {
			case "teacher-start-share":
				handleTeacherStartShare(payload?.persistent);
				return { ok: true };
			case "teacher-stop-share":
				handleTeacherStopShare();
				return { ok: true };
			case "command":
				return handleWhitelistedCommand(payload);
			default:
				return { ok: false, error: `unknown event type: ${type}` };
		}
	} catch (err) {
		return { ok: false, error: err.message };
	}
});

// One-time viewer token + open the "view student" window.
ipcMain.on("CREATE_VIEW_WINDOW", (event, { studentId, socketId }) => {
	const token = crypto.randomBytes(16).toString("hex");
	viewerTokens.set(token, {
		studentId: socketId, // the student's MAIN socket id
		exp: Date.now() + 60_000,
	});
	const url = `${path.join(STATIC_RES_PATH, "share.html")}?mode=view-student&studentId=${encodeURIComponent(
		socketId,
	)}&auth=${token}&serverUrl=${encodeURIComponent(
		`http://localhost:${PORT}`,
	)}`;
	createScreenShareWindow(`file://${url}`, `Viewing ${studentId}`, socketId);
});

ipcMain.on("SET_ALWAYS_ON_TOP", (event, flag) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win) {
		win.setAlwaysOnTop(flag);
	}
});

// ---------------------------------------------------------------------------
// Screen Share Window Management (host side)
// ---------------------------------------------------------------------------
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
		backgroundColor: "#f5f5f7",
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			preload: path.join(__dirname, "preload.cjs"),
		},
	});

	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	win.webContents.on("console-message", (event, level, message) => {
		console.log(`[share-window:${title}] ${message}`);
		if (level >= 2) audit("share-window-console", { title, message });
	});
	win.loadURL(streamUrl);
	if (DEV_MODE && process.env.INHAND_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
	win.on("closed", () => {
		screenShareWindows.delete(peerId);
	});

	screenShareWindows.set(peerId, win);
	return win;
}

ipcMain.on("CREATE_SHARE_WINDOW", (event, { url, title, peerId }) => {
	createScreenShareWindow(url, title, peerId);
});

// ---------------------------------------------------------------------------
// Electron UI
// ---------------------------------------------------------------------------
let settingsWindow = null;

// "Settings…" lives in the app menu (Cmd+,) and opens its own small window,
// so the dashboard stays clean. It uses the same preload/IPC bridge.
function openSettingsWindow() {
	if (settingsWindow && !settingsWindow.isDestroyed()) {
		settingsWindow.focus();
		return;
	}
	settingsWindow = new BrowserWindow({
		width: 540,
		height: 680,
		resizable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		show: false,
		title: "InHand Settings",
		backgroundColor: "#f5f5f7",
		icon: path.join(STATIC_RES_PATH, "icon.png"),
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			preload: path.join(__dirname, "preload.cjs"),
		},
	});
	settingsWindow.setMenuBarVisibility(false);
	settingsWindow.webContents.on("console-message", (event, level, message) => {
		console.log(`[settings-window] ${message}`);
		if (level >= 2) audit("settings-window-console", { message });
	});
	settingsWindow.once("ready-to-show", () => settingsWindow.show());
	settingsWindow.on("closed", () => {
		settingsWindow = null;
	});
	settingsWindow.loadURL(`http://localhost:${PORT}/settings.html`);
	if (DEV_MODE && process.env.INHAND_DEVTOOLS === "1") settingsWindow.webContents.openDevTools({ mode: "detach" });
}

function showWindow() {
	if (!mainWindow) {
		mainWindow = new BrowserWindow({
			width: 1100,
			height: 840,
			minWidth: 860,
			minHeight: 620,
			show: false,
			titleBarStyle: "hidden",
			titleBarOverlay: { color: "#f5f5f7", symbolColor: "#1d1d1f", height: 38 },
			backgroundColor: "#f5f5f7",
			icon: path.join(STATIC_RES_PATH, "icon.png"),
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				preload: path.join(__dirname, "preload.cjs"),
			},
		});
		mainWindow.webContents.on("console-message", (event, level, message) => {
			console.log(`[admin-window] ${message}`);
			if (level >= 2) audit("admin-window-console", { message });
		});
		mainWindow.loadURL(`http://localhost:${PORT}/admin`);
		if (DEV_MODE && process.env.INHAND_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });
		mainWindow.on("close", (e) => {
			if (!app.isQuitting) {
				e.preventDefault();
				mainWindow.hide();
				// The app keeps running in the menu bar; it only lives in the
				// Dock while the Admin dashboard is open.
				if (process.platform === "darwin") app.dock.hide();
			}
		});
		mainWindow.webContents.on("will-navigate", (event, url) => {
			if (url.startsWith("http:") || url.startsWith("https:")) {
				event.preventDefault();
				shell.openExternal(url);
			}
		});
		mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		mainWindow.on("window-handle-double-click", () => {
			if (mainWindow.isMaximized()) {
				mainWindow.unmaximize();
			} else {
				mainWindow.maximize();
			}
		});
	}
	if (process.platform === "darwin") app.dock.show();
	mainWindow.show();
}

function createTray() {
	// Menu bar icons must be monochrome glyphs without a background so they
	// match the system menu bar. The full-color logo is only for the Dock.
	const iconPath = path.join(STATIC_RES_PATH, "trayTemplate.png");
	let icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
	icon.setTemplateImage(true);

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

	tray.setToolTip("InHand Server");
	tray.setContextMenu(contextMenu);
}

// Standard macOS application menu so the app behaves like a real Dock app
// (About / Quit, Edit for copy & paste, Window for minimize/zoom/close).
function installAppMenu() {
	const isMac = process.platform === "darwin";
	const template = [
		...(isMac
			? [
					{
						label: app.name,
						submenu: [
							{ role: "about" },
							{ type: "separator" },
							{
								label: "Open Admin Dashboard",
								click: () => showWindow(),
							},
							{
								label: "Settings…",
								accelerator: "CmdOrCtrl+,",
								click: () => openSettingsWindow(),
							},
							{ type: "separator" },
							{ role: "hide" },
							{ role: "hideOthers" },
							{ role: "unhide" },
							{ type: "separator" },
							{ role: "quit" },
						],
					},
				]
			: []),
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize" },
				{ role: "zoom" },
				...(isMac
					? [
							{ type: "separator" },
							{ role: "front" },
						]
					: [{ role: "close" }]),
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
	// Show the WG brand mark in the Dock even in dev mode (packaged builds
	// already get it from res/logo.icns via electron-builder).
	if (process.platform === "darwin") {
		const dockIcon = nativeImage.createFromPath(
			path.join(STATIC_RES_PATH, "icon.png"),
		);
		if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
	}
	installAppMenu();
	showWindow();
	createTray();
	app.setLoginItemSettings({
		openAtLogin: true,
		openAsHidden: true,
		path: app.getPath("exe"),
	});
});

// Clicking the Dock icon opens the dashboard like any real macOS app.
app.on("activate", () => {
	showWindow();
});

// Cmd+Q (or Dock → Quit) must actually quit, not just hide the window.
app.on("before-quit", () => {
	app.isQuitting = true;
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
