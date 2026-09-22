// InHand Capture — hidden renderer.
// Grabs the first screen via desktopCapturer + getUserMedia, JPEG-encodes
// frames at ~15 fps, and forwards them to the main process for local push.

const { ipcRenderer } = require("electron");

// Page-level error visibility: anything that throws here goes to main.
window.addEventListener("error", (e) => {
	ipcRenderer.send("CAPTURE_ERROR", "page error: " + (e.message || e.error));
});
window.addEventListener("unhandledrejection", (e) => {
	ipcRenderer.send("CAPTURE_ERROR", "unhandled rejection: " + (e.reason && e.reason.message));
});
ipcRenderer.send("CAPTURE_ERROR", "page js started");

const video = document.getElementById("cap");
const canvas = document.getElementById("cv");
const ctx = canvas.getContext("2d");

const FPS = 15;
const FRAME_MS = Math.round(1000 / FPS);
const JPEG_QUALITY = 0.7;

let running = false;

async function startCapture() {
	if (running) return;
	running = true;
	try {
		const sources = await ipcRenderer.invoke("GET_SCREEN_SOURCES");
		if (!sources || !sources.length) {
			ipcRenderer.send("CAPTURE_ERROR", "no screen sources");
			return;
		}
		const source = sources[0];
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {
				mandatory: {
					chromeMediaSource: "desktop",
					chromeMediaSourceId: source.id,
					minWidth: 1280,
					maxWidth: 1920,
					minHeight: 720,
					maxHeight: 1080,
					maxFrameRate: FPS,
				},
			},
		});
		video.srcObject = stream;
		await video.play();
		await new Promise((resolve) => {
			video.addEventListener("loadedmetadata", resolve, { once: true });
		});
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		console.log(`[capture] capturing ${canvas.width}x${canvas.height} @ ${FPS}fps`);
		setInterval(() => {
			if (video.videoWidth === 0) return;
			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
			canvas.toBlob(
				async (blob) => {
					if (!blob) return;
					const buf = Buffer.from(await blob.arrayBuffer());
					ipcRenderer.send("CAPTURE_FRAME", { jpg: buf });
				},
				"image/jpeg",
				JPEG_QUALITY,
			);
		}, FRAME_MS);
	} catch (err) {
		ipcRenderer.send("CAPTURE_ERROR", String(err && err.message));
		running = false;
	}
}

// Mock mode: verify the local frame pipeline end-to-end without needing the
// Screen Recording grant. Set INHAND_CAPTURE_MOCK=1 in the helper's env.
function startMock() {
	canvas.width = 640;
	canvas.height = 360;
	const t0 = Date.now();
	setInterval(() => {
		const t = (Date.now() - t0) / 1000;
		ctx.fillStyle = "#102030";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = `hsl(${(t * 60) % 360}, 80%, 60%)`;
		ctx.fillRect((t * 50) % 560, 120, 80, 80);
		ctx.fillStyle = "#fff";
		ctx.font = "24px monospace";
		ctx.fillText("CAPTURE MOCK " + Math.round(t), 20, 60);
		canvas.toBlob(async (blob) => {
			if (!blob) return;
			const buf = Buffer.from(await blob.arrayBuffer());
			ipcRenderer.send("CAPTURE_FRAME", { jpg: buf });
		}, "image/jpeg", 0.7);
	}, 100);
	console.log("[capture] MOCK MODE on");
}

// Mock mode (INHAND_CAPTURE_MOCK=1 in the helper's env) validates the local
// frame pipeline without needing the Screen Recording grant.
const isMock = new URLSearchParams(window.location.search).get("mock") === "1";
if (isMock) {
	startMock();
} else {
	startCapture();
}
