const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
	getScreenSources: () => ipcRenderer.invoke("GET_SCREEN_SOURCES"),
	setAlwaysOnTop: (flag) => ipcRenderer.send("SET_ALWAYS_ON_TOP", flag),
	onStopShare: (callback) =>
		ipcRenderer.on("stop-share", () => callback()),
	closeShareWindow: () => ipcRenderer.send("CLOSE_SHARE_WINDOW"),
});
