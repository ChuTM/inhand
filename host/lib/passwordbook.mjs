/**
 * host/lib/passwordbook.mjs — Teacher's local password book.
 *
 * A map of { hostname: adminPassword } for student machines, stored at rest
 * encrypted with the SAME master password as the teacher keyring
 * (scrypt + AES-256-GCM via wrapPrivateKeys/unwrapPrivateKeys).
 *
 * The master password is cached in memory after unlock (see keystore.getPassword()),
 * so the password book can be read/written without re-prompting.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

let bookPath = null;

const KDF_OPTS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const b64 = (b) => b.toString("base64");
const fromB64 = (s) => Buffer.from(String(s), "base64");

/** scrypt + AES-256-GCM over an arbitrary JSON payload (password book blob). */
function sealBook(entries, password) {
	const salt = crypto.randomBytes(16);
	const kek = crypto.scryptSync(password, salt, 32, KDF_OPTS);
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);
	const ct = Buffer.concat([cipher.update(JSON.stringify(entries), "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return {
		v: 1,
		kdf: "scrypt",
		salt: b64(salt),
		iv: b64(iv),
		ct: b64(ct),
		tag: b64(tag),
	};
}

function openBook(blob, password) {
	if (!blob || blob.v !== 1 || blob.kdf !== "scrypt") {
		throw new Error("Unsupported password book format");
	}
	const kek = crypto.scryptSync(password, fromB64(blob.salt), 32, KDF_OPTS);
	const decipher = crypto.createDecipheriv("aes-256-gcm", kek, fromB64(blob.iv));
	decipher.setAuthTag(fromB64(blob.tag));
	const pt = Buffer.concat([
		decipher.update(fromB64(blob.ct)),
		decipher.final(),
	]);
	return JSON.parse(pt.toString("utf8"));
}

export function initPasswordBook(baseDir) {
	bookPath = path.join(baseDir, "credentials.json");
}

export function passwordBookExists() {
	return bookPath && fs.existsSync(bookPath);
}

/** Decrypt the password book with the in-memory master password. */
export function loadPasswordBook(masterPassword) {
	if (!masterPassword) throw new Error("Password book locked: unlock the teacher keyring first");
	if (!passwordBookExists()) return {};
	const blob = JSON.parse(fs.readFileSync(bookPath, "utf8"));
	return openBook(blob, masterPassword); // throws on wrong password
}

/** Encrypt and persist the password book (map of hostname -> password). */
export function savePasswordBook(entries, masterPassword) {
	if (!masterPassword) throw new Error("Password book locked: unlock the teacher keyring first");
	const clean = {};
	for (const [host, pw] of Object.entries(entries || {})) {
		const h = String(host).trim();
		const p = String(pw ?? "");
		if (h && p) clean[h] = p;
	}
	const blob = sealBook(clean, masterPassword);
	fs.writeFileSync(bookPath, JSON.stringify(blob, null, 2), { mode: 0o600 });
	return clean;
}

/**
 * Parse "hostname:password" lines (one per line). Also tolerates CSV
 * "hostname,password". Empty lines and comments (#) are skipped.
 */
export function parsePasswordBookText(text) {
	const entries = {};
	for (const rawLine of String(text).split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		let host = "";
		let pw = "";
		if (line.includes(":")) {
			const i = line.indexOf(":");
			host = line.slice(0, i).trim();
			pw = line.slice(i + 1).trim();
		} else if (line.includes(",")) {
			const i = line.indexOf(",");
			host = line.slice(0, i).trim();
			pw = line.slice(i + 1).trim();
		}
		if (host && pw) entries[host] = pw;
	}
	return entries;
}

/** Serialize entries back to "hostname:password" lines. */
export function serializePasswordBook(entries) {
	return Object.entries(entries || {})
		.map(([host, pw]) => `${host}:${pw}`)
		.join("\n");
}
