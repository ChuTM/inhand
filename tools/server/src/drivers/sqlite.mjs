/**
 * tools/server/drivers/sqlite.mjs — SQLite storage driver (node:sqlite).
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync) — no third-party
 * dependency. This is the default driver. The schema is small and documented
 * here; swap to another DB by implementing the same interface (README.md).
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";

export const name = "sqlite";

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS registrations (
  public_ip      TEXT PRIMARY KEY,
  lan_ip         TEXT NOT NULL,
  sign_pub       TEXT NOT NULL,
  enc_pub        TEXT NOT NULL,
  prev_sign_pub  TEXT,
  prev_enc_pub   TEXT,
  prev_since     INTEGER,
  school_name    TEXT,
  token          TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token      TEXT PRIMARY KEY,
  label      TEXT,
  created_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS updates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version    TEXT NOT NULL,
  url        TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  platform   TEXT NOT NULL DEFAULT 'mac-arm64',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  email    TEXT PRIMARY KEY,
  uid      TEXT,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  public_key  TEXT NOT NULL,
  counter     INTEGER NOT NULL DEFAULT 0,
  transports  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id      TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expiry  INTEGER NOT NULL,
  ts      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  actor   TEXT,
  method  TEXT,
  detail  TEXT,
  ip      TEXT
);
`;

function rowToReg(row) {
	if (!row) return null;
	return {
		publicIp: row.public_ip,
		lanIp: row.lan_ip,
		signPub: row.sign_pub,
		encPub: row.enc_pub,
		prevSignPub: row.prev_sign_pub || null,
		prevEncPub: row.prev_enc_pub || null,
		prevSince: row.prev_since || null,
		schoolName: row.school_name,
		token: row.token,
		registrationId: row.registration_id,
		ts: row.ts,
		expiresAt: row.expires_at,
		lastHeartbeat: row.last_heartbeat,
	};
}

export async function init(config) {
	if (config.DB_FILE !== ":memory:") {
		fs.mkdirSync(path.dirname(config.DB_FILE), { recursive: true });
	}
	db = new DatabaseSync(config.DB_FILE);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(SCHEMA);
}

export async function getRegistration(publicIp) {
	const row = db
		.prepare("SELECT * FROM registrations WHERE public_ip = ?")
		.get(publicIp);
	return rowToReg(row);
}

export async function listRegistrations() {
	return db
		.prepare("SELECT * FROM registrations ORDER BY last_heartbeat DESC")
		.all()
		.map(rowToReg);
}

export async function upsertRegistration(reg) {
	db.prepare(
		`INSERT INTO registrations (
		   public_ip, lan_ip, sign_pub, enc_pub, prev_sign_pub, prev_enc_pub,
		   prev_since, school_name, token, registration_id, ts, expires_at,
		   last_heartbeat
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(public_ip) DO UPDATE SET
		   lan_ip = excluded.lan_ip,
		   sign_pub = excluded.sign_pub,
		   enc_pub = excluded.enc_pub,
		   prev_sign_pub = excluded.prev_sign_pub,
		   prev_enc_pub = excluded.prev_enc_pub,
		   prev_since = excluded.prev_since,
		   school_name = excluded.school_name,
		   token = excluded.token,
		   registration_id = excluded.registration_id,
		   ts = excluded.ts,
		   expires_at = excluded.expires_at,
		   last_heartbeat = excluded.last_heartbeat`,
	).run(
		reg.publicIp,
		reg.lanIp,
		reg.signPub,
		reg.encPub,
		reg.prevSignPub || null,
		reg.prevEncPub || null,
		reg.prevSince || null,
		reg.schoolName || null,
		reg.token,
		reg.registrationId,
		reg.ts,
		reg.expiresAt,
		reg.lastHeartbeat,
	);
	return reg;
}

export async function deleteRegistration(publicIp) {
	const res = db
		.prepare("DELETE FROM registrations WHERE public_ip = ?")
		.run(publicIp);
	return res.changes > 0;
}

export async function sweepExpired(now) {
	const res = db
		.prepare("DELETE FROM registrations WHERE expires_at <= ?")
		.run(now);
	return res.changes;
}

export async function createToken(label) {
	const token = crypto.randomBytes(24).toString("hex");
	db.prepare("INSERT INTO tokens (token, label, created_at, revoked) VALUES (?, ?, ?, 0)").run(
		token,
		label || "",
		Date.now(),
	);
	return token;
}

export async function listTokens() {
	return db
		.prepare("SELECT token, label, created_at, revoked FROM tokens ORDER BY created_at DESC")
		.all();
}

export async function revokeToken(token) {
	const res = db.prepare("DELETE FROM tokens WHERE token = ?").run(token);
	return res.changes > 0;
}

export async function tokenValid(token) {
	const row = db
		.prepare("SELECT revoked FROM tokens WHERE token = ?")
		.get(token);
	return !!row && row.revoked === 0;
}

export async function listUpdates() {
	return db
		.prepare("SELECT id, version, url, sha256, platform, created_at FROM updates ORDER BY created_at DESC")
		.all();
}

export async function getCurrentUpdate(platform) {
	const row = platform
		? db
				.prepare("SELECT id, version, url, sha256, platform, created_at FROM updates WHERE platform = ? ORDER BY created_at DESC LIMIT 1")
				.get(platform)
		: db
				.prepare("SELECT id, version, url, sha256, platform, created_at FROM updates ORDER BY created_at DESC LIMIT 1")
				.get();
	return row || null;
}

export async function publishUpdate(u) {
	const res = db
		.prepare("INSERT INTO updates (version, url, sha256, platform, created_at) VALUES (?, ?, ?, ?, ?)")
		.run(u.version, u.url, u.sha256, u.platform || "mac-arm64", Date.now());
	return Number(res.lastInsertRowid);
}

export async function deleteUpdate(id) {
	const res = db.prepare("DELETE FROM updates WHERE id = ?").run(id);
	return res.changes > 0;
}

export async function stats() {
	const r = db.prepare("SELECT COUNT(*) AS n FROM registrations").get();
	const t = db.prepare("SELECT COUNT(*) AS n FROM tokens").get();
	const u = db.prepare("SELECT COUNT(*) AS n FROM updates").get();
	const a = db.prepare("SELECT COUNT(*) AS n FROM admins").get();
	return { driver: name, registrations: r.n, tokens: t.n, updates: u.n, admins: a.n };
}

// ---- Admin allowlist ------------------------------------------------------

export async function listAdmins() {
	return db.prepare("SELECT email, uid, added_at FROM admins ORDER BY added_at").all();
}

export async function getAdminByEmail(email) {
	const row = db.prepare("SELECT email, uid, added_at FROM admins WHERE email = ?").get(String(email).toLowerCase());
	return row || null;
}

export async function addAdmin({ email, uid }) {
	const key = String(email).toLowerCase();
	db.prepare("INSERT INTO admins (email, uid, added_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET uid = excluded.uid").run(
		key,
		uid || "",
		Date.now(),
	);
	return { email: key, uid: uid || "", added_at: Date.now() };
}

export async function removeAdmin(email) {
	const res = db.prepare("DELETE FROM admins WHERE email = ?").run(String(email).toLowerCase());
	return res.changes > 0;
}

// ---- WebAuthn credentials --------------------------------------------------

export async function listCredentials() {
	return db.prepare("SELECT id, email, public_key, counter, transports, created_at FROM webauthn_credentials").all().map((r) => ({
		id: r.id,
		email: r.email,
		publicKey: r.public_key,
		counter: r.counter,
		transports: r.transports ? JSON.parse(r.transports) : [],
		created_at: r.created_at,
	}));
}

export async function getCredential(credId) {
	const r = db.prepare("SELECT id, email, public_key, counter, transports, created_at FROM webauthn_credentials WHERE id = ?").get(String(credId));
	if (!r) return null;
	return {
		id: r.id,
		email: r.email,
		publicKey: r.public_key,
		counter: r.counter,
		transports: r.transports ? JSON.parse(r.transports) : [],
		created_at: r.created_at,
	};
}

export async function addCredential(cred) {
	db.prepare(
		"INSERT INTO webauthn_credentials (id, email, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run(cred.id, cred.email, cred.publicKey, cred.counter || 0, JSON.stringify(cred.transports || []), Date.now());
	return cred;
}

export async function deleteCredential(credId) {
	const res = db.prepare("DELETE FROM webauthn_credentials WHERE id = ?").run(String(credId));
	return res.changes > 0;
}

// ---- WebAuthn challenges (TTL enforced on read) ----------------------------

export async function saveChallenge(id, ch) {
	db.prepare("INSERT INTO auth_challenges (id, payload, expiry, ts) VALUES (?, ?, ?, ?)").run(
		String(id),
		JSON.stringify(ch),
		ch.expiry || 0,
		Date.now(),
	);
}

export async function getChallenge(id) {
	const row = db.prepare("SELECT id, payload, expiry FROM auth_challenges WHERE id = ?").get(String(id));
	if (!row) return null;
	if (row.expiry && row.expiry <= Date.now()) {
		db.prepare("DELETE FROM auth_challenges WHERE id = ?").run(String(id));
		return null;
	}
	return JSON.parse(row.payload);
}

export async function deleteChallenge(id) {
	const res = db.prepare("DELETE FROM auth_challenges WHERE id = ?").run(String(id));
	return res.changes > 0;
}

// ---- Audit log ---------------------------------------------------------------

export async function audit(entry) {
	db.prepare("INSERT INTO audit (ts, actor, method, detail, ip) VALUES (?, ?, ?, ?, ?)").run(
		Date.now(),
		entry.actor || "",
		entry.method || "",
		entry.detail || "",
		entry.ip || "",
	);
	// keep the log bounded
	db.prepare("DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 500)").run();
}

export async function listAudit(limit = 50) {
	return db.prepare("SELECT ts, actor, method, detail, ip FROM audit ORDER BY id DESC LIMIT ?").all(limit);
}

export async function close() {
	if (db) {
		db.close();
		db = null;
	}
}
