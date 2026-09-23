/**
 * tools/server/drivers/memory.mjs — In-memory storage driver.
 *
 * Implements the storage interface (see README.md). Data is lost on restart;
 * useful for tests and short-lived dev servers.
 */
export const name = "memory";

import crypto from "crypto";

const registrations = new Map(); // publicIp -> reg
const tokens = new Map(); // token -> {token, label, created_at, revoked}
const updates = []; // [{id, version, url, sha256, platform, created_at}]
const admins = new Map(); // email -> {email, uid, added_at}
const credentials = new Map(); // credentialId -> cred
const challenges = new Map(); // challengeId -> {data, email, rpId, origin, expiry}
const auditLog = []; // [{ts, actor, method, detail, ip}]
let updateSeq = 0;

export async function init() {
	/* nothing to do */
}

export async function getRegistration(publicIp) {
	return registrations.get(publicIp) || null;
}

export async function listRegistrations() {
	return [...registrations.values()];
}

export async function upsertRegistration(reg) {
	registrations.set(reg.publicIp, reg);
	return reg;
}

export async function deleteRegistration(publicIp) {
	return registrations.delete(publicIp);
}

export async function sweepExpired(now) {
	let removed = 0;
	for (const [ip, reg] of registrations) {
		if (reg.expiresAt && reg.expiresAt <= now) {
			registrations.delete(ip);
			removed++;
		}
	}
	return removed;
}

export async function createToken(label) {
	const token = crypto.randomBytes(24).toString("hex");
	tokens.set(token, { token, label, created_at: Date.now(), revoked: 0 });
	return token;
}

export async function listTokens() {
	return [...tokens.values()];
}

export async function revokeToken(token) {
	return tokens.delete(token);
}

export async function tokenValid(token) {
	const t = tokens.get(token);
	return !!t && t.revoked === 0;
}

export async function listUpdates() {
	return [...updates].sort((a, b) => b.created_at - a.created_at);
}

export async function getCurrentUpdate(platform) {
	const match = updates
		.filter((u) => !platform || u.platform === platform)
		.sort((a, b) => b.created_at - a.created_at);
	return match[0] || null;
}

export async function publishUpdate(u) {
	const id = ++updateSeq;
	updates.push({ id, ...u, created_at: Date.now() });
	return id;
}

export async function deleteUpdate(id) {
	const i = updates.findIndex((u) => String(u.id) === String(id));
	if (i !== -1) updates.splice(i, 1);
	return i !== -1;
}

export async function stats() {
	return {
		driver: name,
		registrations: registrations.size,
		tokens: tokens.size,
		updates: updates.length,
		admins: admins.size,
	};
}

// ---- Admin allowlist ------------------------------------------------------

export async function listAdmins() {
	return [...admins.values()].sort((a, b) => a.added_at - b.added_at);
}

export async function getAdminByEmail(email) {
	return admins.get(String(email).toLowerCase()) || null;
}

export async function addAdmin({ email, uid }) {
	const key = String(email).toLowerCase();
	const admin = { email: key, uid: uid || "", added_at: Date.now() };
	admins.set(key, admin);
	return admin;
}

export async function removeAdmin(email) {
	return admins.delete(String(email).toLowerCase());
}

// ---- WebAuthn credentials --------------------------------------------------

export async function listCredentials() {
	return [...credentials.values()];
}

export async function getCredential(credId) {
	return credentials.get(String(credId)) || null;
}

export async function addCredential(cred) {
	credentials.set(cred.id, { ...cred, created_at: Date.now() });
	return cred;
}

export async function deleteCredential(credId) {
	return credentials.delete(String(credId));
}

// ---- WebAuthn challenges (TTL enforced on read) ----------------------------

export async function saveChallenge(id, ch) {
	challenges.set(String(id), { ...ch, ts: Date.now() });
}

export async function getChallenge(id) {
	const ch = challenges.get(String(id));
	if (!ch) return null;
	if (ch.expiry && ch.expiry <= Date.now()) {
		challenges.delete(String(id));
		return null;
	}
	return ch;
}

export async function deleteChallenge(id) {
	return challenges.delete(String(id));
}

// ---- Audit log ---------------------------------------------------------------

export async function audit(entry) {
	auditLog.push({ ts: Date.now(), ...entry });
	if (auditLog.length > 500) auditLog.shift();
}

export async function listAudit(limit = 50) {
	return [...auditLog].reverse().slice(0, limit);
}

export async function close() {
	/* nothing to do */
}
