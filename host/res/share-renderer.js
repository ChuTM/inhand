let socket = null;
let peerConnection = null;
let currentMode = null;
let targetId = null;
let serverUrl = null;
let localPreviewStream = null;
// The student's SHARE-WINDOW socket id (learned from the incoming offer),
// used for ICE candidates and the answer. Distinct from the student's main
// socket id.
let studentShareWindowId = null;

const video = document.getElementById("remote-video");
const connecting = document.getElementById("connecting");

const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get("mode");
const studentId = urlParams.get("studentId");
const serverUrlParam = urlParams.get("serverUrl");
const persistentParam = urlParams.get("persistent");
const authToken = urlParams.get("auth");

if (persistentParam === "true") {
	window.electronAPI.setAlwaysOnTop(true);
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

		if (mode === "view-student" && studentId) {
			currentMode = "view-student";
			targetId = studentId;
			// Prove this window is the teacher's: the main process minted a
			// one-time token when the admin clicked "View Screen".
			socket.emit("viewer-claim", { token: authToken, studentId });
			socket.on("viewer-claim-ok", () => {
				startViewStudent(studentId);
			});
		} else if (mode === "teacher-preview") {
			currentMode = "teacher-preview";
			startTeacherPreview();
		} else {
			showConnecting("Invalid mode");
		}
	});

	socket.on("connect_error", (err) => {
		console.error("Share window connection error:", err.message);
		showConnecting("Connection failed: " + err.message);
	});

	// A student accepted our request and sent their stream as an offer
	socket.on("screen-share-offer", async (data) => {
		if (!peerConnection) return;
		studentShareWindowId = data.fromId;
		try {
			await peerConnection.setRemoteDescription(
				new RTCSessionDescription(data.sdp),
			);
			const answer = await peerConnection.createAnswer();
			await peerConnection.setLocalDescription(answer);
			socket.emit("screen-share-answer", {
				targetId: studentShareWindowId,
				sdp: answer,
			});
		} catch (err) {
			console.error("Error handling offer:", err);
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
			const cand = data.candidate || {};
			const ice = {};
			if (cand.candidate != null) ice.candidate = cand.candidate;
			if (cand.sdpMid != null) ice.sdpMid = cand.sdpMid;
			if (cand.sdpMLineIndex != null) ice.sdpMLineIndex = cand.sdpMLineIndex;
			await peerConnection.addIceCandidate(new RTCIceCandidate(ice));
		} catch (err) {
			console.error("Error handling ICE candidate:", err);
		}
	});

	// Close the teacher's local preview when the broadcast stops.
	// (A "view student" window stays open — it shows a student's screen.)
	socket.on("teacher-stop-share", () => {
		if (currentMode === "teacher-preview") stopShare();
	});
}

// Teacher's own always-on-top preview of what is being shared
async function startTeacherPreview() {
	try {
		const sources = await window.electronAPI.getScreenSources();
		if (sources.length === 0) {
			throw new Error("No screen sources available");
		}
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {
				mandatory: {
					chromeMediaSource: "desktop",
					chromeMediaSourceId: sources[0].id,
					minWidth: 1280,
					maxWidth: 1920,
					minHeight: 720,
					maxHeight: 1080,
				},
			},
		});
		localPreviewStream = stream;
		video.srcObject = stream;
		video.hidden = false;
		connecting.classList.add("hidden");
	} catch (err) {
		console.error("Failed to start teacher preview:", err);
		showConnecting("Failed to start preview: " + err.message);
	}
}

// View a student's screen: create a receive-only connection and ask the
// student to start streaming. The student sends us a WebRTC offer, which we
// answer in the screen-share-offer handler above.
async function startViewStudent(studentId) {
	try {
		peerConnection = new RTCPeerConnection({
			iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
		});
		peerConnection.addTransceiver("video", { direction: "recvonly" });

		peerConnection.onicecandidate = (event) => {
			if (event.candidate) {
				// Candidates are only gathered after we answer the student's
				// offer, by which point studentShareWindowId is known.
				socket.emit("screen-share-ice-candidate", {
					targetId: studentShareWindowId || studentId,
					candidate: event.candidate,
				});
			}
		};

		peerConnection.ontrack = (event) => {
			console.log("Received student track:", event.track.kind);
			video.srcObject = event.streams[0];
			video.hidden = false;
			connecting.classList.add("hidden");
		};

		peerConnection.onconnectionstatechange = () => {
			if (
				peerConnection.connectionState === "failed" ||
				peerConnection.connectionState === "disconnected"
			) {
				stopShare();
			}
		};

		// Ask the student (their main socket) to open a share window
		socket.emit("request-student-stream", { studentId });
		showConnecting("Requesting student screen...");
	} catch (err) {
		console.error("Failed to start view student:", err);
		showConnecting("Failed to start: " + err.message);
	}
}

function stopShare() {
	if (peerConnection) {
		peerConnection.close();
		peerConnection = null;
	}
	if (localPreviewStream) {
		localPreviewStream.getTracks().forEach((track) => track.stop());
		localPreviewStream = null;
	}
	window.close();
}

video.onerror = (e) => {
	console.error("Video error:", e);
	showConnecting("Failed to load stream");
};

window.addEventListener("beforeunload", () => {
	if (peerConnection) peerConnection.close();
	if (localPreviewStream) {
		localPreviewStream.getTracks().forEach((track) => track.stop());
	}
});

init();
