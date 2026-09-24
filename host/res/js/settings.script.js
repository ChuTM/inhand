// InHand Settings — standalone window renderer. Uses only the preload IPC
// bridge (window.electronAPI); no socket.io, no dashboard logic.
// The window is gated: settings stay hidden until the keyring is unlocked.
(function () {
	"use strict";

	const $ = (id) => document.getElementById(id);
	const api = () => window.electronAPI;

	function esc(v) {
		return String(v ?? "").replace(/[&<>"']/g, (c) => ({
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		}[c]));
	}

	function toast(message, kind) {
		const root = $("toast-root");
		if (!root) return;
		const el = document.createElement("div");
		el.className = "toast" + (kind === "error" ? " toast-error" : "");
		el.textContent = message;
		root.appendChild(el);
		requestAnimationFrame(() => el.classList.add("show"));
		setTimeout(() => {
			el.classList.remove("show");
			setTimeout(() => el.remove(), 350);
		}, 4500);
	}

	// ------------------------------------------------------------------ gate
	function showSetup() {
		$("setup-form").classList.remove("hidden");
		$("login-form").classList.add("hidden");
	}
	function showLogin() {
		$("login-form").classList.remove("hidden");
		$("setup-form").classList.add("hidden");
	}
	function hideGate() {
		$("security-gate").classList.add("hidden");
		$("settings-content").classList.remove("hidden");
		refresh();
	}

	async function initGate() {
		try {
			const state = await api().getSecurityState();
			if (state.needsSetup) {
				showSetup();
			} else if (state.locked) {
				showLogin();
			} else {
				hideGate();
			}
		} catch (e) {
			// No preload bridge (page opened in a plain browser): show the
			// settings content instead of leaving the user stuck at a gate.
			$("security-gate").classList.add("hidden");
			$("settings-content").classList.remove("hidden");
		}
	}

	$("btn-setup").addEventListener("click", async () => {
		const password = $("setup-password").value;
		const password2 = $("setup-password2").value;
		if (password !== password2) {
			$("setup-error").textContent = "Passwords do not match.";
			return;
		}
		$("setup-error").textContent = "";
		const res = await api().setup(password, "", "");
		if (res.ok) {
			toast("Keyring created — you can now configure cloud settings.");
			hideGate();
		} else {
			$("setup-error").textContent = res.error;
		}
	});

	$("btn-unlock").addEventListener("click", async () => {
		const password = $("login-password").value;
		$("login-error").textContent = "";
		const res = await api().unlock(password);
		if (res.ok) {
			toast("Unlocked — teacher keys are in memory.");
			hideGate();
		} else {
			$("login-error").textContent = res.error;
		}
	});

	// Enter to unlock / confirm setup
	["setup-password", "setup-password2"].forEach((id) => {
		$(id).addEventListener("keydown", (e) => {
			if (e.key === "Enter") $("btn-setup").click();
		});
	});
	$("login-password").addEventListener("keydown", (e) => {
		if (e.key === "Enter") $("btn-unlock").click();
	});

	// ------------------------------------------------------------- settings
	async function refresh() {
		try {
			const state = await api().getSecurityState();
			$("key-fingerprint").textContent = state.signFingerprint || "—";
			const reg = $("cloud-reg-state");
			if (state.registered) {
				reg.innerHTML =
					'<span class="ok">Registered.</span> Cloud API: <code>' +
					esc(state.apiUrl || "—") +
					"</code>";
			} else {
				reg.textContent =
					"Not registered — add a registration token and API URL, then Save.";
			}
			const settings = await api().getSettings();
			if (!settings.locked) {
				$("set-school").value = settings.schoolName || "";
				$("set-token").value = settings.registrationToken || "";
				$("set-apiurl").value = settings.apiUrl || "";
			}
		} catch (e) {
			toast("Failed to load settings: " + e.message, "error");
		}
	}

	$("btn-save-settings").addEventListener("click", async () => {
		const res = await api().setSettings({
			schoolName: $("set-school").value.trim(),
			registrationToken: $("set-token").value.trim(),
			apiUrl: $("set-apiurl").value.trim(),
		});
		if (res.ok) {
			toast("Settings saved and re-registered with the cloud.");
			refresh();
		} else {
			toast(res.error || "Failed to save settings", "error");
		}
	});

	$("btn-copy-pub").addEventListener("click", async () => {
		try {
			const state = await api().getSecurityState();
			if (!state.signPub) {
				toast("No public key available yet.", "error");
				return;
			}
			await navigator.clipboard.writeText(state.signPub);
			toast("Teacher public key copied to clipboard.");
		} catch (e) {
			toast("Copy failed: " + e.message, "error");
		}
	});

	// ------------------------------------------------------- change password
	$("btn-change-password").addEventListener("click", async () => {
		const oldPw = prompt("Current password:");
		if (!oldPw) return;
		const newPw = prompt("New password (min 8 chars):");
		if (!newPw) return;
		if (newPw.length < 8) {
			toast("New password must be at least 8 characters.", "error");
			return;
		}
		const res = await api().changePassword(oldPw, newPw);
		if (res.ok) {
			toast("Password changed.");
		} else {
			toast(res.error || "Failed to change password", "error");
		}
	});

	// ------------------------------------------------- rotate (type to confirm)
	const ROTATE_CONFIRM_TEXT = "REGENERATE";
	let rotatePassword = null;
	let rotatedPubs = null;

	function openRotateModal() {
		rotatePassword = null;
		rotatedPubs = null;
		$("rotate-confirm-input").value = "";
		$("rotate-error").textContent = "";
		$("rotate-done-panel").classList.add("hidden");
		$("rotate-confirm-panel").classList.remove("hidden");
		$("btn-rotate-confirm").disabled = false;
		$("rotate-modal").classList.remove("hidden");
		$("rotate-confirm-input").focus();
	}
	function closeRotateModal() {
		$("rotate-modal").classList.add("hidden");
	}

	$("btn-rotate").addEventListener("click", () => {
		rotatePassword = prompt("Enter your current password to regenerate keys:");
		if (rotatePassword === null || rotatePassword === "") {
			rotatePassword = null;
			return;
		}
		openRotateModal();
	});
	$("btn-rotate-cancel").addEventListener("click", closeRotateModal);
	$("rotate-confirm-input").addEventListener("keydown", (e) => {
		if (e.key === "Enter") $("btn-rotate-confirm").click();
		if (e.key === "Escape") closeRotateModal();
	});
	$("btn-rotate-confirm").addEventListener("click", async () => {
		if ($("rotate-confirm-input").value.trim() !== ROTATE_CONFIRM_TEXT) {
			$("rotate-error").textContent =
				'Type REGENERATE exactly to confirm key rotation.';
			return;
		}
		$("btn-rotate-confirm").disabled = true;
		const res = await api().rotateKeys(rotatePassword);
		rotatePassword = null;
		if (res.ok) {
			rotatedPubs = res.pubs || null;
			$("rotate-done-result").innerHTML =
				"Fingerprint changed from <code>" +
				esc(res.oldFingerprint || "?") +
				"</code> to <code>" +
				esc(res.newFingerprint || "?") +
				"</code>. The new public key was <strong>re-registered with the cloud</strong>.";
			$("rotate-confirm-panel").classList.add("hidden");
			$("rotate-done-panel").classList.remove("hidden");
		} else {
			$("rotate-error").textContent = res.error || "Failed to regenerate keys";
			$("btn-rotate-confirm").disabled = false;
		}
	});
	$("btn-rotate-done").addEventListener("click", () => {
		closeRotateModal();
		refresh();
	});
	$("btn-rotate-copy-new").addEventListener("click", async () => {
		const pub = rotatedPubs?.signPub;
		if (!pub) {
			toast("New public key not available.", "error");
			return;
		}
		try {
			await navigator.clipboard.writeText(pub);
			toast("New teacher public key copied to clipboard.");
			const fb = $("rotate-copy-feedback");
			if (fb) {
				fb.classList.remove("hidden");
				setTimeout(() => fb.classList.add("hidden"), 1500);
			}
		} catch (e) {
			toast("Copy failed: " + e.message, "error");
		}
	});

	document.addEventListener("DOMContentLoaded", initGate);
})();
