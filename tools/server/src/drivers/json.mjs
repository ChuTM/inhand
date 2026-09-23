/**
 * tools/server/drivers/json.mjs — JSON-file storage driver.
 *
 * Persists everything to one JSON file (atomic writes). Same interface as the
 * sqlite driver; pick it with STORAGE_DRIVER=json.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

export const name = "json";

let file = null;
let data = {
	registrations: {},
	tokens: {},
	updates: [],
	updateSeq: 0,
	admins: {},
	credentials: {},
	challenges: {},
	audit: [],
};

function load() {
	if (fs.existsSync(file)) {
		try {
			data = JSON.parse(fs.readFileSync(file, "utf8"));
			// Backfill fields added in newer versions
			data.admins = data.admins || {};
			data.credentials = data.credentials || {};
			data.challenges = data.challenges || {};
			data.audit = data.audit || [];
		} catch (e) {
			console.error("[storage:json] Corrupt data file, starting empty:", e.message);
			data = {
				registrations: {},
				tokens: {},
				updates: [],
				updateSeq: 0,
				admins: {},
				credentials: {},
				challenges: {},
				audit: [],
			};
		}
	}
}

function save() {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = file + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export async function init(config) {
	file = config.JSON_FILE;
	load();
}

export async function getRegistration(publicIp) {
	return data.registrations[publicIp] || null;
}

export async function listRegistrations() {
	return Object.values(data.registrations);
}

export async function upsertRegistration(reg) {
	data.registrations[reg.publicIp] = reg;
	save();
	return reg;
}

export async function deleteRegistration(publicIp) {
	const existed = !!data.registrations[publicIp];
	delete data.registrations[publicIp];
	if (existed) save();
	return existed;
}

export async function sweepExpired(now) {
	let removed = 0;
	for (const [ip, reg] of Object.entries(data.registrations)) {
		if (reg.expiresAt && reg.expiresAt <= now) {
			delete data.registrations[ip];
			removed++;
		}
	}
	if (removed) save();
	return removed;
}

export async function createToken(label) {
	const token = crypto.randomBytes(24).toString("hex");
	data.tokens[token] = { token, label, created_at: Date.now(), revoked: 0 };
	save();
	return token;
}

export async function listTokens() {
	return Object.values(data.tokens);
}

export async function revokeToken(token) {
	const existed = !!data.tokens[token];
	if (existed) {
		delete data.tokens[token];
		save();
	}
	return existed;
}

export async function tokenValid(token) {
	const t = data.tokens[token];
	return !!t && t.revoked === 0;
}

export async function listUpdates() {
	return [...data.updates].sort((a, b) => b.created_at - a.created_at);
}

export async function getCurrentUpdate(platform) {
	const match = data.updates
		.filter((u) => !platform || u.platform === platform)
		.sort((a, b) => b.created_at - a.created_at);
	return match[0] || null;
}

export async function publishUpdate(u) {
	const id = ++data.updateSeq;
	data.updates.push({ id, ...u, created_at: Date.now() });
	save();
	return id;
}

export async function deleteUpdate(id) {
	const i = data.updates.findIndex((u) => String(u.id) === String(id));
	if (i !== -1) {
		data.updates.splice(i, 1);
		save();
		return true;
	}
	return false;
}

export async function stats() {
	return {
		driver: name,
		registrations: Object.keys(data.registrations).length,
		tokens: Object.keys(data.tokens).length,
		updates: data.updates.length,
		admins: Object.keys(data.admins).length,
	};
}

// ---- Admin allowlist ------------------------------------------------------

export async function listAdmins() {
	return Object.values(data.admins).sort((a, b) => a.added_at - b.added_at);
}

export async function getAdminByEmail(email) {
	return data.admins[String(email).toLowerCase()] || null;
}

export async function addAdmin({ email, uid }) {
	const key = String(email).toLowerCase();
	const admin = { email: key, uid: uid || "", added_at: Date.now() };
	data.admins[key] = admin;
	save();
	return admin;
}

export async function removeAdmin(email) {
	const key = String(email).toLowerCase();
	const existed = !!data.admins[key];
	delete data.admins[key];
	if (existed) save();
	return existed;
}

// ---- WebAuthn credentials --------------------------------------------------

export async function listCredentials() {
	return Object.values(data.credentials);
}

export async function getCredential(credId) {
	return data.credentials[String(credId)] || null;
}

export async function addCredential(cred) {
	data.credentials[cred.id] = { ...cred, created_at: Date.now() };
	save();
	return cred;
}

export async function deleteCredential(credId) {
	const key = String(credId);
	const existed = !!data.credentials[key];
	delete data.credentials[key];
	if (existed) save();
	return existed;
}

// ---- WebAuthn challenges (TTL enforced on read) ----------------------------

export async function saveChallenge(id, ch) {
	data.challenges[String(id)] = { ...ch, ts: Date.now() };
	save();
}

export async function getChallenge(id) {
	const ch = data.challenges[String(id)];
	if (!ch) return null;
	if (ch.expiry && ch.expiry <= Date.now()) {
		delete data.challenges[String(id)];
		save();
		return null;
	}
	return ch;
}

export async function deleteChallenge(id) {
	const key = String(id);
	const existed = !!data.challenges[key];
	delete data.challenges[key];
	if (existed) save();
	return existed;
}

// ---- Audit log ---------------------------------------------------------------

export async function audit(entry) {
	data.audit.push({ ts: Date.now(), ...entry });
	if (data.audit.length > 500) data.audit.shift();
	save();
}

export async function listAudit(limit = 50) {
	return [...data.audit].reverse().slice(0, limit);
}

export async function close() {
	/* nothing to do */
}
