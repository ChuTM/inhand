const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
	getScreenSources: () => ipcRenderer.invoke("GET_SCREEN_SOURCES"),
	ensureCaptureHelper: () => ipcRenderer.invoke("ENSURE_CAPTURE_HELPER"),
	startCaptureBridge: (url) => ipcRenderer.send("START_CAPTURE_BRIDGE", url),
	stopCaptureBridge: () => ipcRenderer.send("STOP_CAPTURE_BRIDGE"),
	onCaptureFrame: (callback) => {
		const listener = (_event, data) => callback(data);
		ipcRenderer.on("capture-frame", listener);
		return () => ipcRenderer.removeListener("capture-frame", listener);
	},
	setAlwaysOnTop: (flag) => ipcRenderer.send("SET_ALWAYS_ON_TOP", flag),
	onStopShare: (callback) =>
		ipcRenderer.on("stop-share", () => callback()),
	closeShareWindow: () => ipcRenderer.send("CLOSE_SHARE_WINDOW"),
	setOverlayViewing: (v) => ipcRenderer.send("OVERLAY_VIEWING", !!v),
	// All crypto runs in the main process; the renderer never sees keys.
	encryptForTeacher: (obj) => ipcRenderer.invoke("ENCRYPT_FOR_TEACHER", obj),
	verifyTeacherEvent: (type, env) =>
		ipcRenderer.invoke("VERIFY_TEACHER_EVENT", { type, env }),
});
