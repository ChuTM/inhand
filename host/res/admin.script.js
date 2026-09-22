const socket = io();

let localStream = null;
let peerConnections = new Map();
let isSharing = false;
let currentShareSourceId = null;
let commandWhitelist = { commands: {} };

// ---------------------------------------------------------------------------
// Security gate (first-run setup / unlock)
// ---------------------------------------------------------------------------
async function initSecurity() {
	let state;
	try {
		state = await window.electronAPI.getSecurityState();
	} catch (e) {
		// No preload bridge (e.g. page opened in a plain browser): show the
		// dashboard without the gate instead of leaving an unhandled rejection.
		console.warn("Security gate unavailable:", e.message);
		document.getElementById("security-gate").classList.add("hidden");
		initializeConsoleLayout();
		return;
	}
	const gate = document.getElementById("security-gate");
	const setupForm = document.getElementById("setup-form");
	const loginForm = document.getElementById("login-form");

	if (state.needsSetup) {
		gate.classList.remove("hidden");
		setupForm.classList.remove("hidden");
		loginForm.classList.add("hidden");
	} else if (state.locked) {
		gate.classList.remove("hidden");
		loginForm.classList.remove("hidden");
		setupForm.classList.add("hidden");
	} else {
		gate.classList.add("hidden");
		loadCommandWhitelist();
	}
}

document.getElementById("btn-setup").addEventListener("click", async () => {
	const password = document.getElementById("setup-password").value;
	const password2 = document.getElementById("setup-password2").value;
	if (password !== password2) {
		document.getElementById("setup-error").textContent =
			"Passwords do not match.";
		return;
	}
	const schoolName = document.getElementById("setup-school").value.trim();
	const registrationToken = document.getElementById("setup-token").value.trim();
	const res = await window.electronAPI.setup(
		password,
		schoolName,
		registrationToken,
	);
	if (res.ok) {
		initSecurity();
		initializeConsoleLayout();
		fetchStatus();
	} else {
		document.getElementById("setup-error").textContent = res.error;
	}
});

document.getElementById("btn-unlock").addEventListener("click", async () => {
	const password = document.getElementById("login-password").value;
	const res = await window.electronAPI.unlock(password);
	if (res.ok) {
		initSecurity();
		initializeConsoleLayout();
		fetchStatus();
	} else {
		document.getElementById("login-error").textContent = res.error;
	}
});

// ---------------------------------------------------------------------------
// Command whitelist composer (send structured commands only)
// ---------------------------------------------------------------------------
async function loadCommandWhitelist() {
	commandWhitelist = await window.electronAPI.getCommandWhitelist();
	const select = document.getElementById("cmd-type");
	select.innerHTML = '<option value="">Select command…</option>';
	for (const type of Object.keys(commandWhitelist.commands || {})) {
		const def = commandWhitelist.commands[type];
		const opt = document.createElement("option");
		opt.value = type;
		opt.textContent = `${type} — ${def.description || ""}`;
		select.appendChild(opt);
	}
	renderCommandParams();
}

function renderCommandParams() {
	const type = document.getElementById("cmd-type").value;
	const paramsBox = document.getElementById("cmd-params");
	paramsBox.innerHTML = "";
	if (!type || !commandWhitelist.commands[type]) return;
	const def = commandWhitelist.commands[type];
	for (const [key, spec] of Object.entries(def.params || {})) {
		const input = document.createElement("input");
		input.className = "cmd-param";
		input.dataset.key = key;
		input.dataset.type = spec.type;
		input.placeholder = `${key}${spec.required ? " *" : ""} (${spec.type})`;
		paramsBox.appendChild(input);
	}
}

document.getElementById("cmd-type").addEventListener("change", renderCommandParams);

document.getElementById("btn-send-cmd").addEventListener("click", sendCommand);

async function sendCommand() {
	const type = document.getElementById("cmd-type").value;
	if (!type) return;
	const def = commandWhitelist.commands[type];
	const params = {};
	let ok = true;
	for (const input of document.querySelectorAll("#cmd-params .cmd-param")) {
		const key = input.dataset.key;
		const specType = input.dataset.type;
		const raw = input.value.trim();
		if (specType === "boolean") {
			params[key] = raw === "" ? undefined : raw === "true";
		} else if (specType === "number") {
			params[key] = raw === "" ? undefined : Number(raw);
		} else {
			params[key] = raw === "" ? undefined : raw;
		}
		if (def.params[key]?.required && params[key] === undefined) {
			ok = false;
			input.classList.add("has-error");
		} else {
			input.classList.remove("has-error");
		}
	}
	if (!ok) {
		appendConsoleOutput("Admin System", "Missing required parameter(s).", true);
		return;
	}
	const res = await window.electronAPI.sendTeacherEvent("command", {
		type,
		params,
	});
	if (!res.ok) {
		appendConsoleOutput("Admin System", res.error || "Command rejected.", true);
	}
}

// ---------------------------------------------------------------------------
// Wallpaper Guard quick actions
// ---------------------------------------------------------------------------
const wpPathInput = document.getElementById("wp-path");
async function sendWallpaperCommand(type, params) {
	const res = await window.electronAPI.sendTeacherEvent("command", { type, params });
	if (!res.ok) {
		appendConsoleOutput("Admin System", res.error || "Command rejected.", true);
		return;
	}
	appendConsoleOutput("Admin System", type + " sent to all clients.");
}
const wpGuardToggle = document.getElementById("wp-guard-toggle");
if (wpGuardToggle) {
	wpGuardToggle.addEventListener("change", async () => {
		if (wpGuardToggle.checked) {
			const p = (wpPathInput.value || "").trim();
			if (!p || (!p.startsWith("/") && !/^https?:\/\//i.test(p))) {
				appendConsoleOutput(
					"Admin System",
					"Enter an absolute path or http(s) URL for the wallpaper first.",
					true,
				);
				wpGuardToggle.checked = false;
				return;
			}
			await sendWallpaperCommand("wallpaper", { path: p });
		} else {
			await sendWallpaperCommand("configMode", { on: false });
		}
	});
}

// ---------------------------------------------------------------------------
// Screen sharing
// ---------------------------------------------------------------------------
async function loadScreenSources() {
	try {
		const sources = await window.electronAPI.getScreenSources();
		const select = document.getElementById("screen-source-select");
		select.innerHTML = sources
			.map((s) => `<option value="${s.id}">${s.name}</option>`)
			.join("");
		if (sources.length > 0) {
			currentShareSourceId = sources[0].id;
			document.getElementById("share-permission-warning")?.classList.add("hidden");
		} else {
			// macOS returns an empty list when this app has no Screen
			// Recording permission (each rebuild invalidates the grant).
			const warn = document.getElementById("share-permission-warning");
			if (warn) warn.classList.remove("hidden");
		}
		return sources;
	} catch (err) {
		console.error("Failed to load screen sources:", err);
		return [];
	}
}

async function toggleScreenShare() {
	if (!isSharing) {
		await startScreenShare();
	} else {
		await stopScreenShare();
	}
}

async function startScreenShare() {
	const btn = document.getElementById("btn-share-screen");
	const selector = document.getElementById("screen-source-selector");
	const status = document.getElementById("share-status");
	const select = document.getElementById("screen-source-select");
	const persistentCheckbox = document.getElementById("persistent-share-window");
	const isPersistent = persistentCheckbox ? persistentCheckbox.checked : false;

	try {
		if (select.options.length === 0) {
			await loadScreenSources();
		}
		if (select.options.length === 0) {
			alert(
				"No screen sources found. Grant Screen Recording permission to InHand Admin in System Settings → Privacy & Security → Screen Recording, then quit and reopen the app.",
			);
			return;
		}
		currentShareSourceId = select.value;

		localStream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {
				mandatory: {
					chromeMediaSource: "desktop",
					chromeMediaSourceId: currentShareSourceId,
					minWidth: 1280,
					maxWidth: 1920,
					minHeight: 720,
					maxHeight: 1080,
				},
			},
		});

		isSharing = true;

		// Privileged: the main process signs teacher-start-share and broadcasts it.
		const res = await window.electronAPI.sendTeacherEvent(
			"teacher-start-share",
			{ persistent: isPersistent },
		);
		if (!res.ok) throw new Error(res.error || "Signing failed");

		// Optional always-on-top local preview of what the teacher is sharing
		if (isPersistent) {
			const shareUrl = `${window.location.origin}/share.html?mode=teacher-preview&persistent=true&serverUrl=${encodeURIComponent(window.location.origin)}`;
			window.electronAPI.createShareWindow(
				shareUrl,
				"My Screen Share Preview",
				"teacher-preview",
			);
		}

		btn.innerHTML = `<i data-lucide="monitor-off"></i><span>Stop Sharing</span>`;
		btn.classList.add("sharing");
		selector.classList.add("hidden");
		status.classList.remove("hidden");
		lucide.createIcons({
			attrs: { class: "lucide-icon", "stroke-width": 1.5 },
		});
	} catch (err) {
		console.error("Failed to start screen share:", err);
		alert("Failed to start screen sharing: " + err.message);
	}
}

async function stopScreenShare() {
	const btn = document.getElementById("btn-share-screen");
	const selector = document.getElementById("screen-source-selector");
	const status = document.getElementById("share-status");

	await window.electronAPI.sendTeacherEvent("teacher-stop-share", {});

	peerConnections.forEach((pc) => pc.close());
	peerConnections.clear();

	if (localStream) {
		localStream.getTracks().forEach((track) => track.stop());
		localStream = null;
	}

	isSharing = false;
	btn.innerHTML = `<i data-lucide="monitor"></i><span>Start Sharing</span>`;
	btn.classList.remove("sharing");
	selector.classList.remove("hidden");
	status.classList.add("hidden");
	lucide.createIcons({
		attrs: { class: "lucide-icon", "stroke-width": 1.5 },
	});
}

// A student share window asks to receive the teacher's broadcast.
// data.fromId is the student's share-window socket id.
socket.on("screen-share-offer", async (data) => {
	if (!localStream || !isSharing) {
		appendConsoleOutput(
			"Screen Sharing",
			"Student offer ignored: the teacher is not actively sharing.",
			true,
		);
		return;
	}
	const studentWindowId = data.fromId;
	appendConsoleOutput(
		"Screen Sharing",
		`Offer received from ${studentWindowId}; answering...`,
	);

	let pc = peerConnections.get(studentWindowId);
	if (!pc) {
		pc = new RTCPeerConnection({
			iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
		});

		localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

		pc.onicecandidate = (event) => {
			if (event.candidate) {
				socket.emit("screen-share-ice-candidate", {
					targetId: studentWindowId,
					candidate: event.candidate,
				});
			}
		};

		pc.onconnectionstatechange = () => {
			if (
				pc.connectionState === "disconnected" ||
				pc.connectionState === "failed" ||
				pc.connectionState === "closed"
			) {
				pc.close();
				peerConnections.delete(studentWindowId);
			}
		};

		peerConnections.set(studentWindowId, pc);
	}

	try {
		await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);
		socket.emit("screen-share-answer", {
			targetId: studentWindowId,
			sdp: answer,
		});
		appendConsoleOutput("Screen Sharing", "Answer sent to " + studentWindowId);
	} catch (err) {
		console.error("Error answering student stream request:", err);
		appendConsoleOutput("Screen Sharing", "Answer failed: " + err.message, true);
	}
});

// The admin page opens a "view student" window; the main process mints a
// one-time viewer token so the window can claim its role.
function viewStudentScreen(studentId, socketId) {
	window.electronAPI.createViewWindow(studentId, socketId);
}

socket.on("screen-share-answer", async (data) => {
	const pc = peerConnections.get(data.fromId);
	if (pc) {
		try {
			await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
			console.log("Answer received from student window:", data.fromId);
		} catch (err) {
			console.error("Error setting remote description:", err);
		}
	}
});

socket.on("screen-share-ice-candidate", async (data) => {
	const pc = peerConnections.get(data.fromId);
	if (pc) {
		try {
			await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
		} catch (err) {
			console.error("Error adding ICE candidate:", err);
		}
	}
});

socket.on("teacher-stop-share", () => {
	peerConnections.forEach((pc) => pc.close());
	peerConnections.clear();
});

// ---------------------------------------------------------------------------
// Console + device table (unchanged behavior)
// ---------------------------------------------------------------------------
// The console zone is part of the dashboard layout now; this is kept as a
// safe guard so older callers still work.
function initializeConsoleLayout() {
	if (!document.getElementById("command-console-zone")) return;
	const stream = document.getElementById("console-stream");
	if (stream && !stream.childElementCount) {
		const hint = document.createElement("p");
		hint.className = "empty";
		hint.textContent = "Command output appears here.";
		stream.appendChild(hint);
	}
}

async function fetchStatus() {
	try {
		const response = await fetch("/api/status");
		const data = await response.json();
		const table = document.getElementById("device-table");
		if (!table) return;

		const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({
			"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
		}[c]));

		table.innerHTML = data
			.map((device) => {
				const isOnline = device.status === "Online";
				return `
                        <tr>
                            <td><span class="device-name">${esc(device.name)}</span></td>
                            <td>
                                <span class="status-badge ${isOnline ? "online" : "offline"}">
                                    <span class="status-dot ${isOnline ? "online" : "offline"}"></span>
                                    ${esc(device.status.toUpperCase())}
                                </span>
                            </td>
                            <td class="timestamp">${esc(device.lastSeen || device.firstSeen)}</td>
                            <td>
                                ${isOnline
									? `<button class="view-btn" data-action="view" data-name="${esc(device.name)}" data-sid="${esc(device.socketId)}"><i data-lucide="eye"></i> View Screen</button>`
									: `<button class="btn-remove" data-action="remove" data-name="${esc(device.name)}" title="Remove History">Remove</button>`}
                            </td>
                        </tr>
                    `;
			})
			.join("");

		const empty = document.getElementById("clients-empty");
		if (empty) empty.classList.toggle("hidden", data.length > 0);
		const count = document.getElementById("client-count");
		if (count) count.textContent = data.length;

		if (window.lucide) {
			lucide.createIcons({
				attrs: { class: 'lucide-icon', 'stroke-width': 1.5 }
			});
		}
	} catch (err) {
		console.error("Failed to fetch status:", err);
	}
}

function appendConsoleOutput(deviceName, payload, isError = false, fullFallback = {}) {
	const streamContainer = document.getElementById("console-stream");
	if (!streamContainer) return;

	const timestamp = new Date().toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const cleanOutput =
		typeof payload === "string"
			? payload.trim()
			: JSON.stringify(payload, null, 2);

	if (!cleanOutput) return;

	const safeId = `device-log-${deviceName.replace(/[^a-zA-Z0-9]/g, "-")}`;
	let deviceCard = document.getElementById(safeId);

	if (!deviceCard) {
		deviceCard = document.createElement("details");
		deviceCard.id = safeId;
		deviceCard.className = "device-terminal-group";
		deviceCard.open = true;
		deviceCard.innerHTML = `
            <summary class="device-terminal-header">
                <span class="header-icon">⌃</span>
                <span class="device-title">${deviceName}</span>
            </summary>
            <div class="device-terminal-body"></div>
        `;
		streamContainer.insertBefore(deviceCard, streamContainer.firstChild);
	}

	const terminalBody = deviceCard.querySelector(".device-terminal-body");
	const commandBlock = document.createElement("div");
	commandBlock.className = `terminal-command-entry ${isError ? "has-error" : ""}`;
	commandBlock.innerHTML = `
        <div class="command-meta">[${timestamp}] > ${fullFallback?.command || ""} ${isError ? "ERR" : "OUT"}</div>
        <pre class="command-payload"><code>${cleanOutput}</code></pre>
    `;
	terminalBody.appendChild(commandBlock);
}

// Title bar double-click → maximize (moved out of inline HTML for strict CSP).
document.getElementById("title-bar").addEventListener("dblclick", () => {
	if (window.electronAPI?.handleDoubleClick) window.electronAPI.handleDoubleClick();
});

// Event delegation for table actions (no inline onclick under strict CSP).
document.addEventListener("click", (e) => {
	const el = e.target.closest("[data-action]");
	if (!el) return;
	const action = el.dataset.action;
	if (action === "view") {
		viewStudentScreen(el.dataset.name, el.dataset.sid);
	} else if (action === "remove") {
		removeConnectionHistory(el.dataset.name);
	}
});

document.addEventListener("DOMContentLoaded", () => {
	initializeConsoleLayout();
	serverAddress();

	document.getElementById("screen-source-select").addEventListener("change", (e) => {
		currentShareSourceId = e.target.value;
	});

	loadScreenSources().then(() => {
		document.getElementById("screen-source-selector").classList.remove("hidden");
	});

	document.getElementById("btn-share-screen").addEventListener("click", toggleScreenShare);

	const configToggle = document.getElementById("config_mode");
	if (configToggle) {
		configToggle.addEventListener("input", async (e) => {
			const csrf = await window.electronAPI.getCsrf();
			fetch("/api/control-access", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-CSRF-Token": csrf,
				},
				body: JSON.stringify({ allow_config: e.target.checked }),
			});
		});
	}

	initSecurity();
});

socket.on("refresh-ui", fetchStatus);

socket.on("admin-command-result", (data) => {
	console.log(data);
	if (!data || typeof data !== "object") {
		console.warn("Received malformed command result:", data);
		return;
	}
	appendConsoleOutput(
		data.user || "Unknown Device",
		data.result?.stdout || "No output",
		false,
		data[0],
	);
	if (data.result?.stderr) {
		appendConsoleOutput(
			data.user || "Unknown Device",
			data.result.stderr,
			true,
			data[0],
		);
	}
});

socket.on("admin-command-error", (error) => {
	const name = error.deviceName || "System Network Error";
	const msg = error.message || JSON.stringify(error);
	appendConsoleOutput(name, msg, true, error);
});

socket.onAny((event, ...args) => {
	console.log(`Received event: ${event}`, args);
});

function removeConnectionHistory(deviceName) {
	window.electronAPI.getCsrf().then((csrf) => {
		fetch("/api/remove-history", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-CSRF-Token": csrf,
			},
			body: JSON.stringify({ deviceName }),
		})
			.then((response) => {
				if (!response.ok) {
					throw new Error(`Server responded with status ${response.status}`);
				}
				return response.json();
			})
			.then(() => {
				alert(`Removed connection history for ${deviceName}`);
				socket.emit("refresh-ui");
			})
			.catch((err) => {
				console.error("Failed to remove connection history:", err);
				alert(`Failed to remove connection history for ${deviceName}`);
				socket.emit("refresh-ui");
			});
	});
}

function serverAddress() {
	fetch("/server")
		.then((res) => res.text())
		.then((address) => {
			const addr_el = document.getElementById("server-address");
			addr_el.textContent = address + ":7100";
			addr_el.addEventListener("click", () => {
				navigator.clipboard.writeText(address + ":7100");
				addr_el.classList.add("copied");
				setTimeout(() => addr_el.classList.remove("copied"), 500);
			});
		});
}
