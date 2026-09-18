/**
 * host/lib/audit.js — Append-only JSONL audit log (ESM).
 * Writes to userData/audit.log. One JSON object per line; never rewritten.
 */
import fs from "fs";
import path from "path";

let logPath = null;
let stream = null;

export function initAudit(baseDir) {
	logPath = path.join(baseDir, "audit.log");
	stream = fs.createWriteStream(logPath, { flags: "a" });
	stream.on("error", (err) => {
		console.error("Audit log write failed:", err);
	});
}

export function audit(event, detail = {}) {
	const entry = {
		ts: new Date().toISOString(),
		event,
		...detail,
	};
	const line = JSON.stringify(entry) + "\n";
	if (stream) {
		stream.write(line);
	} else {
		console.warn("Audit not initialized; dropping entry:", line.trim());
	}
	console.log("[audit]", entry.event, JSON.stringify(detail));
}
