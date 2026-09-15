const socket = io();

let localStream = null;
let peerConnections = new Map();
let isSharing = false;
let currentShareSourceId = null;

// ---- Screen sharing ----

async function loadScreenSources() {
	try {
		const sources = await window.electronAPI.getScreenSources();
		const select = document.getElementById("screen-source-select");
		select.innerHTML = sources
			.map((s) => `<option value="${s.id}">${s.name}</option>`)
			.join("");
		if (sources.length > 0) {
			currentShareSourceId = sources[0].id;
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
	const persistentCheckbox = document.getElementById(
		"persistent-share-window",
	);
	const isPersistent = persistentCheckbox ? persistentCheckbox.checked : false;

	try {
		if (select.options.length === 0) {
			await loadScreenSources();
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

		// Tell every client to open a share window; each student window will
		// send us a WebRTC offer that we answer with this local stream.
		// persistent tells clients whether their window should be locked
		// (always-on-top, not closable by the student).
		socket.emit("teacher-start-share", { persistent: isPersistent });

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

	socket.emit("teacher-stop-share");

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
	if (!localStream || !isSharing) return;
	const studentWindowId = data.fromId;

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
	} catch (err) {
		console.error("Error answering student stream request:", err);
	}
});

function viewStudentScreen(studentId, socketId) {
	const shareUrl = `${window.location.origin}/share.html?mode=view-student&studentId=${encodeURIComponent(socketId)}&teacherId=${encodeURIComponent(socket.id)}&persistent=true&serverUrl=${encodeURIComponent(window.location.origin)}`;
	window.electronAPI.createShareWindow(
		shareUrl,
		`Viewing ${studentId}`,
		socketId,
	);
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

function initializeConsoleLayout() {
	const configPanel = document.querySelector(".block-container");
	if (!configPanel) return;

	if (!document.getElementById("command-console-zone")) {
		const consoleSection = document.createElement("section");
		consoleSection.id = "command-console-zone";
		consoleSection.className = "console-zone";
		consoleSection.innerHTML = `
            <h2>Console</h2>
            <div id="console-stream" class="console-container"></div>
        `;

		configPanel.parentNode.insertBefore(consoleSection, configPanel);
	}
}

async function fetchStatus() {
	try {
		const response = await fetch("/api/status");
		const data = await response.json();
		const table = document.getElementById("device-table");
		if (!table) return;

		table.innerHTML = data
			.map((device) => {
				const isOnline = device.status === "Online";
				return `
                        <tr>
                            <td>
                                <span class="device-name">${device.name}</span>
                            </td>
                            <td>
                                <span class="status-badge ${isOnline ? "online" : "offline"}">
                                    <span class="status-dot ${isOnline ? "online" : "offline"}"></span>
                                    ${device.status.toUpperCase()}
                                </span>
                            </td>
                            <td class="timestamp">
                                ${device.lastSeen || device.firstSeen}
                            </td>
                            <td>
                                ${isOnline ? `<button onclick="viewStudentScreen('${device.name}', '${device.socketId}')" class="view-btn"><i data-lucide="eye"></i> View Screen</button>` : ""}
                                ${
									!isOnline
										? `<button onclick="removeConnectionHistory('${device.name}')" class="btn-remove" title="Remove History">⨉</button>`
										: ""
								}
                            </td>
                        </tr>
                    `;
			})
			.join("");
		lucide.createIcons({
			attrs: {
				class: 'lucide-icon',
				'stroke-width': 1.5,
			}
		});
	} catch (err) {
		console.error("Failed to fetch status:", err);
	}
}

function appendConsoleOutput(
	deviceName,
	payload,
	isError = false,
	fullFallback = {},
) {
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

	console.log(deviceName, { payload, isError });

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

document.addEventListener("DOMContentLoaded", () => {
	initializeConsoleLayout();
	fetchStatus();
	serverAddress();
	listenForCommands();

	document.getElementById("screen-source-select").addEventListener("change", (e) => {
		currentShareSourceId = e.target.value;
	});

	// Load available screens/windows up-front so the teacher can pick a source
	loadScreenSources().then(() => {
		document.getElementById("screen-source-selector").classList.remove("hidden");
	});

	document.getElementById("btn-share-screen").addEventListener("click", toggleScreenShare);
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

const configToggle = document.getElementById("config_mode");
if (configToggle) {
	configToggle.addEventListener("input", (e) => {
		fetch("http://localhost:7100/api/control-access", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ allow_config: e.target.checked }),
		});
	});
}

function executeCommand() {
	const commandInput = document.getElementById("exec_command");
	if (!commandInput) return;

	const command = commandInput.value.trim();
	if (command) {
		fetch("http://localhost:7100/api/execute-command", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command }),
		})
			.then((response) => {
				if (!response.ok) {
					throw new Error(
						`Server responded with status ${response.status}`,
					);
				}
				return response.json();
			})
			.catch((err) => {
				console.error(err);
				appendConsoleOutput("Admin System", err.message, true, err);
			});
		commandInput.value = "";
	}
}

function listenForCommands() {
	document.getElementById("exec_command").addEventListener("keydown", (e) => {
		if (e.key === "Enter" && e.metaKey) {
			e.preventDefault();
			executeCommand();
		}
	});
	document
		.getElementById("exec_command")
		.addEventListener("input", function () {
			[["\\sudo ", "echo '{{DEVICE_NAME}}' | sudo -S "]].forEach(
				([pattern, replacement]) => {
					if (this.value.includes(pattern)) {
						this.value = this.value.replace(pattern, replacement);
					}
				},
			);
		});
}

function removeConnectionHistory(deviceName) {
	fetch("http://localhost:7100/api/remove-history", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ deviceName }),
	})
		.then((response) => {
			if (!response.ok) {
				throw new Error(
					`Server responded with status ${response.status}`,
				);
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
}

function serverAddress() {
	fetch("/server")
		.then((res) => res.text())
		.then((address) => {
			const addr_el = document.getElementById("server-address");
			addr_el.textContent = address + ":7100";
			addr_el.addEventListener("click", () => {
				copy(address + ":7100");
				addr_el.classList.add("copied");
				setTimeout(() => {
					addr_el.classList.remove("copied");
				}, 500);
				socket.emit("refresh-ui");
			});
		});
}

function copy(textToCopy) {
	navigator.clipboard.writeText(textToCopy);
}