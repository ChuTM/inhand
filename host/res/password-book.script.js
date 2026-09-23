// InHand Password Book — standalone page renderer.
// Uses only the preload IPC bridge; requires an unlocked keyring.
(function () {
	"use strict";

	const $ = (id) => document.getElementById(id);
	const api = () => window.electronAPI;

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
		}, 3200);
	}

	function countEntries(text) {
		let n = 0;
		for (const line of String(text).split(/\r?\n/)) {
			const t = line.trim();
			if (!t || t.startsWith("#")) continue;
			if (t.includes(":") || t.includes(",")) n++;
		}
		return n;
	}

	async function load() {
		if (!api()?.getPasswordBook) {
			$("book-editor").value = "";
			$("meta").textContent = "Renderer bridge unavailable.";
			return;
		}
		const res = await api().getPasswordBook();
		if (!res?.ok) {
			toast(res?.error || "Keyring locked — open the admin and unlock first.", "error");
			$("book-editor").placeholder =
				"Unlock the admin first (keyring locked), then reload this page.";
			return;
		}
		$("book-editor").value = res.text || "";
		$("meta").textContent = `${countEntries(res.text)} entries · saved locally, encrypted`;
	}

	async function save() {
		const text = $("book-editor").value;
		const btn = $("btn-save");
		btn.disabled = true;
		const original = btn.textContent;
		btn.innerHTML = '<span class="spinner"></span>Saving…';
		const res = await api().savePasswordBook(text);
		btn.disabled = false;
		btn.textContent = original;
		if (!res?.ok) {
			toast(res?.error || "Save failed.", "error");
			return;
		}
		$("book-editor").value = res.text || "";
		$("meta").textContent = `${countEntries(res.text)} entries · saved locally, encrypted`;
		toast(`Saved ${countEntries(res.text)} entries.`);
	}

	function onImport() {
		const file = $("file-input").files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			$("book-editor").value = String(reader.result || "");
			$("meta").textContent = `${countEntries($("book-editor").value)} entries · loaded from file, not yet saved`;
		};
		reader.onerror = () => toast("Could not read the file.", "error");
		reader.readAsText(file, "utf-8");
	}

	$("btn-save").addEventListener("click", save);
	$("btn-import").addEventListener("click", () => $("file-input").click());
	$("file-input").addEventListener("change", onImport);

	load();
})();
