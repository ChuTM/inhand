/**
 * host/lib/keystore.js — Teacher keyring lifecycle (ESM).
 *
 * The keyring file lives under userData/keys/wg-keys.json (mode 0600).
 * Private halves are only decrypted into main-process memory while unlocked.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { generateKeyPair, wrapPrivateKeys, unwrapPrivateKeys } from "./crypto.mjs";

let keysDir = null;
let keyringPath = null;

let unlockedPriv = null; // { signPriv, encPriv } — main-process memory only
let pubs = null; // { signPub, encPub }
let settings = {}; // { schoolName, registrationToken, apiUrl }

export function initKeystore(baseDir, extraSettings = {}) {
	keysDir = path.join(baseDir, "keys");
	fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
	keyringPath = path.join(keysDir, "wg-keys.json");
	settings = { ...extraSettings };
	// Tighten existing perms if a previous version created looser ones.
	try {
		fs.chmodSync(keysDir, 0o700);
		if (fs.existsSync(keyringPath)) fs.chmodSync(keyringPath, 0o600);
	} catch {
		/* best effort */
	}
}

export function keyringExists() {
	return fs.existsSync(keyringPath);
}

export function isUnlocked() {
	return unlockedPriv !== null;
}

export function getPubs() {
	return pubs;
}

export function getSettings() {
	return settings;
}

export function setSettings(patch) {
	settings = { ...settings, ...patch };
}

/** First-run setup: generate keys, wrap with the password, persist. */
export function setup(password, schoolName, registrationToken) {
	if (keyringExists()) throw new Error("Keyring already exists");
	if (!password || password.length < 8) {
		throw new Error("Password must be at least 8 characters");
	}
	const keys = generateKeyPair();
	const blob = wrapPrivateKeys(keys, password);
	fs.writeFileSync(keyringPath, JSON.stringify(blob, null, 2), {
		mode: 0o600,
	});
	pubs = { signPub: keys.signPub, encPub: keys.encPub };
	unlockedPriv = { signPriv: keys.signPriv, encPriv: keys.encPriv };
	settings = {
		schoolName: schoolName || "",
		registrationToken: registrationToken || "",
	};
	return { pubs: { ...pubs }, settings: { ...settings } };
}

/** Unlock with the password; keeps private keys in memory. */
export function unlock(password) {
	if (!keyringExists()) throw new Error("Keyring does not exist");
	const blob = JSON.parse(fs.readFileSync(keyringPath, "utf8"));
	const priv = unwrapPrivateKeys(blob, password); // throws on wrong password
	unlockedPriv = priv;
	pubs = { ...blob.pub };
	return { pubs: { ...pubs }, settings: { ...settings } };
}

export function lock() {
	unlockedPriv = null;
}

/** Rotate: generate a new keypair, re-wrap with the SAME password. */
export function rotateKeys(password) {
	if (!keyringExists()) throw new Error("Keyring does not exist");
	const blob = JSON.parse(fs.readFileSync(keyringPath, "utf8"));
	// Verify the password first so we never brick the keyring with a typo.
	unwrapPrivateKeys(blob, password);
	const keys = generateKeyPair();
	const newBlob = wrapPrivateKeys(keys, password);
	fs.writeFileSync(keyringPath, JSON.stringify(newBlob, null, 2), {
		mode: 0o600,
	});
	pubs = { signPub: keys.signPub, encPub: keys.encPub };
	unlockedPriv = { signPriv: keys.signPriv, encPriv: keys.encPriv };
	return { pubs: { ...pubs } };
}

/** Change password: decrypt with old, re-wrap with new. */
export function changePassword(oldPassword, newPassword) {
	if (!keyringExists()) throw new Error("Keyring does not exist");
	if (!newPassword || newPassword.length < 8) {
		throw new Error("Password must be at least 8 characters");
	}
	const blob = JSON.parse(fs.readFileSync(keyringPath, "utf8"));
	const priv = unwrapPrivateKeys(blob, oldPassword);
	const newBlob = wrapPrivateKeys(
		{ signPriv: priv.signPriv, encPriv: priv.encPriv },
		newPassword,
	);
	fs.writeFileSync(keyringPath, JSON.stringify(newBlob, null, 2), {
		mode: 0o600,
	});
	return true;
}

export function requireUnlocked() {
	if (!unlockedPriv) throw new Error("Keyring locked");
	return unlockedPriv;
}

/** Simple in-memory nonce cache for anti-replay (per process run). */
export function createNonceGuard(windowMs = 120000) {
	const seen = new Map();
	return {
		check(nonce, ts) {
			const now = Date.now();
			if (!nonce || typeof nonce !== "string") return false;
			if (Math.abs(now - ts) > windowMs) return false;
			if (seen.has(nonce)) return false;
			seen.set(nonce, now);
			// Trim old entries to keep the map bounded
			if (seen.size > 10000) {
				for (const [k, v] of seen) {
					if (now - v > windowMs) seen.delete(k);
				}
			}
			return true;
		},
	};
}

export { crypto };
