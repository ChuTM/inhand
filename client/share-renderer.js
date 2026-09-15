let socket = null;
let peerConnection = null;
let currentMode = null;
let targetId = null;
let serverUrl = null;
let localStream = null;

const video = document.getElementById("remote-video");
const connecting = document.getElementById("connecting");

const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get("mode");
const teacherId = urlParams.get("teacherId");
const persistent = urlParams.get("persistent") === "true";
const serverUrlParam = urlParams.get("serverUrl");

if (persistent) {
	window.electronAPI.setAlwaysOnTop(true);
}

// Main-process fallback path: the client's main socket also tells us to stop
if (window.electronAPI.onStopShare) {
	window.electronAPI.onStopShare(() => stopShare());
}

function showConnecting(text) {
	connecting.innerHTML = `<div>${text}</div>`;
	connecting.classList.remove("hidden");
}

async function init() {
	serverUrl = serverUrlParam || `http://localhost:7100`;
	socket = io(serverUrl);

	socket.on("connect", () => {
		console.log("Share window connected to signaling server:", socket.id);

		// Announce ourselves; the server replies with the current share state
		socket.emit("share-window-join", { role: "student" });

		if (mode === "teacher-view" && teacherId) {
			currentMode = "teacher-view";
			targetId = teacherId;
			startTeacherView(teacherId);
		} else if (mode === "student-share" && teacherId) {
			currentMode = "student-share";
			targetId = teacherId;
			// Show the small "being viewed" tag instead of a big black window
			document.body.classList.add("notice-mode");
			document.getElementById("notice-tag").classList.remove("hidden");
			startStudentShare(teacherId);
		} else {
			showConnecting("Invalid mode");
		}
	});

	socket.on("connect_error", (err) => {
		console.error("Share window connection error:", err.message);
		showConnecting("Connection failed: " + err.message);
	});

	// If the teacher already stopped sharing before this window connected,
	// close it instead of waiting forever.
	socket.on("share-active", (data) => {
		if (data && data.active === false && currentMode === "teacher-view") {
			console.log("Teacher is no longer sharing, closing window");
			stopShare();
		}
	});

	socket.on("screen-share-answer", async (data) => {
		if (!peerConnection) return;
		try {
			await peerConnection.setRemoteDescription(
				new RTCSessionDescription(data.sdp),
			);
		} catch (err) {
			console.error("Error handling answer:", err);
		}
	});

	socket.on("screen-share-ice-candidate", async (data) => {
		if (!peerConnection) return;
		try {
			await peerConnection.addIceCandidate(
				new RTCIceCandidate(data.candidate),
			);
		} catch (err) {
			console.error("Error handling ICE candidate:", err);
		}
	});

	// Broadcast stop only affects the teacher's shared-screen windows
	socket.on("teacher-stop-share", () => {
		if (currentMode === "teacher-view") stopShare();
	});
	// Per-student stop only affects this student's shared-screen window
	socket.on("stop-student-stream", () => {
		if (currentMode === "student-share") stopShare();
	});
}

// Watch the teacher's broadcast: create a receive-only connection and send an
// offer to the teacher. The teacher answers with their shared screen.
async function startTeacherView(teacherId) {
	try {
		peerConnection = new RTCPeerConnection({
			iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
		});
		peerConnection.addTransceiver("video", { direction: "recvonly" });

		peerConnection.onicecandidate = (event) => {
			if (event.candidate) {
				socket.emit("screen-share-ice-candidate", {
					targetId: teacherId,
					candidate: event.candidate,
				});
			}
		};

		peerConnection.ontrack = (event) => {
			console.log("Received track from teacher:", event.track.kind);
			video.srcObject = event.streams[0];
			video.hidden = false;
			connecting.classList.add("hidden");
		};

		const offer = await peerConnection.createOffer();
		await peerConnection.setLocalDescription(offer);

		socket.emit("screen-share-offer", {
			targetId: teacherId,
			sdp: offer,
		});

		showConnecting("Connecting to teacher's screen...");
	} catch (err) {
		console.error("Failed to start teacher view:", err);
		showConnecting("Failed to start: " + err.message);
	}
}

// Share this student's screen with the teacher's "view student" window:
// capture locally, then send an offer with the captured tracks.
async function startStudentShare(teacherId) {
	try {
		const sources = await window.electronAPI.getScreenSources();
		if (sources.length === 0) {
			throw new Error("No screen sources available");
		}
		const sourceId = sources[0].id;

		const stream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {
				mandatory: {
					chromeMediaSource: "desktop",
					chromeMediaSourceId: sourceId,
					minWidth: 1280,
					maxWidth: 1920,
					minHeight: 720,
					maxHeight: 1080,
				},
			},
		});
		localStream = stream;

		peerConnection = new RTCPeerConnection({
			iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
		});

		stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

		peerConnection.onicecandidate = (event) => {
			if (event.candidate) {
				socket.emit("screen-share-ice-candidate", {
					targetId: teacherId,
					candidate: event.candidate,
				});
			}
		};

		// If the teacher's viewer disconnects, close this window
		peerConnection.onconnectionstatechange = () => {
			if (
				peerConnection.connectionState === "failed" ||
				peerConnection.connectionState === "disconnected"
			) {
				console.log("Teacher viewer disconnected, closing share window");
				stopShare();
			}
		};

		const offer = await peerConnection.createOffer();
		await peerConnection.setLocalDescription(offer);

		socket.emit("screen-share-offer", {
			targetId: teacherId,
			sdp: offer,
		});
	} catch (err) {
		console.error("Failed to start student share:", err);
		const noticeText = document.getElementById("notice-text");
		if (noticeText) {
			noticeText.textContent = "Sharing failed: " + err.message;
		}
	}
}

function stopShare() {
	if (localStream) {
		localStream.getTracks().forEach((track) => track.stop());
		localStream = null;
	}
	if (peerConnection) {
		peerConnection.close();
		peerConnection = null;
	}
	// Ask the main process to close this window (persistent windows are locked
	// against direct window.close()).
	if (window.electronAPI.closeShareWindow) {
		window.electronAPI.closeShareWindow();
	} else {
		window.close();
	}
}

video.onerror = (e) => {
	console.error("Video error:", e);
	showConnecting("Failed to load stream");
};

window.addEventListener("beforeunload", () => {
	if (localStream) localStream.getTracks().forEach((track) => track.stop());
	if (peerConnection) peerConnection.close();
});

init();
