const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
	getScreenSources: () => ipcRenderer.invoke("GET_SCREEN_SOURCES"),
	handleDoubleClick: () => ipcRenderer.send("window-handle-double-click"),
	onStreamReceived: (callback) => ipcRenderer.on("stream-received", callback),
	createShareWindow: (url, title, peerId) => ipcRenderer.send("CREATE_SHARE_WINDOW", { url, title, peerId }),
	setAlwaysOnTop: (flag) => ipcRenderer.send("SET_ALWAYS_ON_TOP", flag),
	onSetPersistent: (callback) => ipcRenderer.on("SET_PERSISTENT", callback),
});