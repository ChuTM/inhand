const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
	// Screen sources (admin dashboard)
	getScreenSources: () => ipcRenderer.invoke("GET_SCREEN_SOURCES"),
	sfSymbol: (name) => ipcRenderer.invoke("SF_SYMBOL", name),
	handleDoubleClick: () => ipcRenderer.send("window-handle-double-click"),

	// Share windows
	createShareWindow: (url, title, peerId) =>
		ipcRenderer.send("CREATE_SHARE_WINDOW", { url, title, peerId }),
	setAlwaysOnTop: (flag) => ipcRenderer.send("SET_ALWAYS_ON_TOP", flag),

	// Security / keyring
	getSecurityState: () => ipcRenderer.invoke("GET_SECURITY_STATE"),
	setup: (password, schoolName, registrationToken) =>
		ipcRenderer.invoke("SETUP", { password, schoolName, registrationToken }),
	unlock: (password) => ipcRenderer.invoke("UNLOCK", { password }),
	rotateKeys: (password) => ipcRenderer.invoke("ROTATE_KEYS", { password }),
	changePassword: (oldPassword, newPassword) =>
		ipcRenderer.invoke("CHANGE_PASSWORD", { oldPassword, newPassword }),

	// Settings / CSRF / whitelist
	getCsrf: () => ipcRenderer.invoke("GET_CSRF"),
	getSettings: () => ipcRenderer.invoke("GET_SETTINGS"),
	setSettings: (patch) => ipcRenderer.invoke("SET_SETTINGS", patch),
	getCommandWhitelist: () => ipcRenderer.invoke("GET_COMMAND_WHITELIST"),

	// Privileged teacher actions (main signs, renderer never touches the key)
	sendTeacherEvent: (type, payload) =>
		ipcRenderer.invoke("SEND_TEACHER_EVENT", { type, payload }),

	// Open a "view student" window (main mints a one-time viewer token)
	createViewWindow: (studentId, socketId) =>
		ipcRenderer.send("CREATE_VIEW_WINDOW", { studentId, socketId }),

	// Password book (encrypted at rest with the unlock password)
	getPasswordBook: () => ipcRenderer.invoke("GET_PASSWORD_BOOK"),
	savePasswordBook: (text) => ipcRenderer.invoke("SAVE_PASSWORD_BOOK", { text }),
});
