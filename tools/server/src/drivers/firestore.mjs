/**
 * tools/server/drivers/firestore.mjs — Firebase Firestore storage driver.
 *
 * Used for serverless deployment (Vercel / Cloud Functions) where the
 * filesystem is ephemeral and a long-running process is not available.
 * Implements the same storage interface as the other drivers.
 *
 * Credentials (env or config):
 *   FIREBASE_CREDENTIALS_JSON — base64 of the service-account JSON, or the
 *   individual FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
 *   FIREBASE_PRIVATE_KEY fields.
 *
 * Data model:
 *   registrations/<publicIp>   — one active teacher registration per public IP
 *   tokens/<token>             — registration tokens (revoked flag)
 *   updates/<platform>         — the CURRENT update manifest per platform
 *   updates_history/<autoId>   — append-only manifest history (list/delete)
 *
 * NOTE: single-document reads in Firestore are strongly consistent, and
 * discover() uses doc gets — good enough for the one-school-per-IP model.
 */
import crypto from "crypto";

export const name = "firestore";

let _admin = null;
let _db = null;

export function getCredentials(config) {	if (config.FIREBASE_CREDENTIALS_JSON) {
		try {
			return JSON.parse(
				Buffer.from(config.FIREBASE_CREDENTIALS_JSON, "base64").toString("utf8"),
			);
		} catch (e) {
			throw new Error(`FIREBASE_CREDENTIALS_JSON is invalid: ${e.message}`);
		}
	}
	const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = config;
	if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
		return {
			projectId: FIREBASE_PROJECT_ID,
			clientEmail: FIREBASE_CLIENT_EMAIL,
			privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
		};
	}
	throw new Error(
		"Firestore driver needs credentials: set FIREBASE_CREDENTIALS_JSON " +
			"(base64 service-account JSON) or FIREBASE_PROJECT_ID / " +
			"FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.",
	);
}

async function loadAdmin(config) {
	if (_db) return _db;
	const { default: admin } = await import("firebase-admin");
	if (!admin.apps || admin.apps.length === 0) {
		admin.initializeApp({
			credential: admin.credential.cert(getCredentials(config)),
			projectId: config.FIREBASE_PROJECT_ID || undefined,
		});
	}
	_admin = admin;
	_db = admin.firestore();
	return _db;
}

function regToDoc(reg) {
	return {
		publicIp: reg.publicIp,
		lanIp: reg.lanIp,
		signPub: reg.signPub,
		encPub: reg.encPub,
		prevSignPub: reg.prevSignPub || null,
		prevEncPub: reg.prevEncPub || null,
		prevSince: reg.prevSince || null,
		schoolName: reg.schoolName || null,
		token: reg.token,
		registrationId: reg.registrationId,
		ts: reg.ts,
		expiresAt: reg.expiresAt,
		lastHeartbeat: reg.lastHeartbeat,
	};
}

function docToReg(doc) {
	if (!doc.exists) return null;
	const d = doc.data();
	return {
		publicIp: doc.id,
		lanIp: d.lanIp,
		signPub: d.signPub,
		encPub: d.encPub,
		prevSignPub: d.prevSignPub || null,
		prevEncPub: d.prevEncPub || null,
		prevSince: d.prevSince || null,
		schoolName: d.schoolName || "",
		token: d.token,
		registrationId: d.registrationId,
		ts: d.ts,
		expiresAt: d.expiresAt,
		lastHeartbeat: d.lastHeartbeat,
	};
}

export async function getRegistration(publicIp) {
	const db = await loadAdmin(config_holder);
	const doc = await db.collection("registrations").doc(publicIp).get();
	return docToReg(doc);
}

export async function listRegistrations() {
	const db = await loadAdmin(config_holder);
	const snap = await db.collection("registrations").get();
	return snap.docs.map(docToReg);
}

export async function upsertRegistration(reg) {
	const db = await loadAdmin(config_holder);
	await db.collection("registrations").doc(reg.publicIp).set(regToDoc(reg));
	return reg;
}

export async function deleteRegistration(publicIp) {
	const db = await loadAdmin(config_holder);
	const doc = await db.collection("registrations").doc(publicIp).get();
	if (!doc.exists) return false;
	await db.collection("registrations").doc(publicIp).delete();
	return true;
}

export async function sweepExpired(now) {
	const db = await loadAdmin(config_holder);
	const snap = await db
		.collection("registrations")
		.where("expiresAt", "<", now)
		.limit(50)
		.get();
	if (snap.empty) return 0;
	const batch = db.batch();
	for (const d of snap.docs) batch.delete(d.ref);
	await batch.commit();
	return snap.size;
}

export async function createToken(label) {
	const db = await loadAdmin(config_holder);
	const token = crypto.randomBytes(24).toString("hex");
	await db.collection("tokens").doc(token).set({
		label: label || "",
		createdAt: Date.now(),
		revoked: false,
	});
	return token;
}

export async function listTokens() {
	const db = await loadAdmin(config_holder);
	const snap = await db.collection("tokens").get();
	return snap.docs.map((d) => ({ token: d.id, ...d.data() }));
}

export async function revokeToken(token) {
	// Deleting a registration token is final: once revoked it simply no longer
	// exists, so tokenValid() reports false and the admin list stops showing it.
	const db = await loadAdmin(config_holder);
	const doc = await db.collection("tokens").doc(token).get();
	if (!doc.exists) return false;
	await db.collection("tokens").doc(token).delete();
	return true;
}

export async function tokenValid(token) {
	const db = await loadAdmin(config_holder);
	const doc = await db.collection("tokens").doc(token).get();
	return doc.exists && doc.data().revoked === false;
}

export async function listUpdates() {
	const db = await loadAdmin(config_holder);
	const snap = await db
		.collection("updates_history")
		.orderBy("createdAt", "desc")
		.limit(100)
		.get();
	return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getCurrentUpdate(platform) {
	const db = await loadAdmin(config_holder);
	const doc = await db
		.collection("updates")
		.doc(platform || "mac-arm64")
		.get();
	if (!doc.exists) return null;
	return { id: doc.id, ...doc.data() };
}

export async function publishUpdate(u) {
	const db = await loadAdmin(config_holder);
	const platform = u.platform || "mac-arm64";
	const createdAt = Date.now();
	await db.collection("updates").doc(platform).set({
		version: u.version,
		url: u.url,
		sha256: u.sha256,
		platform,
		createdAt,
	});
	const ref = await db.collection("updates_history").add({
		version: u.version,
		url: u.url,
		sha256: u.sha256,
		platform,
		createdAt,
	});
	return ref.id;
}

export async function deleteUpdate(id) {
	const db = await loadAdmin(config_holder);
	const doc = await db.collection("updates_history").doc(id).get();
	if (!doc.exists) return false;
	await db.collection("updates_history").doc(id).delete();
	return true;
}

export async function stats() {
	const db = await loadAdmin(config_holder);
	const [r, t, u, a] = await Promise.all([
		db.collection("registrations").count().get(),
		db.collection("tokens").count().get(),
		db.collection("updates_history").count().get(),
		db.collection("admins").count().get(),
	]);
	return {
		driver: name,
		registrations: r.data().count,
		tokens: t.data().count,
		updates: u.data().count,
		admins: a.data().count,
	};
}

// ---- Admin allowlist ------------------------------------------------------

export async function listAdmins() {
	const db = await loadAdmin(config_holder);
	const snap = await db.collection("admins").orderBy("addedAt", "asc").get();
	return snap.docs.map((d) => ({ email: d.id, uid: d.data().uid || "", added_at: d.data().addedAt }));
}

export async function getAdminByEmail(email) {
	const db = await loadAdmin(config_holder);
	const doc = await db.collection("admins").doc(String(email).toLowerCase()).get();
	if (!doc.exists) return null;
	return { email: doc.id, uid: doc.data().uid || "", added_at: doc.data().addedAt };
}

export async function addAdmin({ email, uid }) {
	const db = await loadAdmin(config_holder);
	const key = String(email).toLowerCase();
	await db.collection("admins").doc(key).set({ uid: uid || "", addedAt: Date.now() });
	return { email: key, uid: uid || "", added_at: Date.now() };
}

export async function removeAdmin(email) {
	const db = await loadAdmin(config_holder);
	const key = String(email).toLowerCase();
	const doc = await db.collection("admins").doc(key).get();
	if (!doc.exists) return false;
	await db.collection("admins").doc(key).delete();
	return true;
}

// ---- WebAuthn credentials --------------------------------------------------

export async function listCredentials() {
	const db = await loadAdmin(config_holder);
	const snap = await db.collection("webauthn_credentials").get();
	return snap.docs.map((d) => ({
		id: d.id,
		email: d.data().email,
		publicKey: d.data().publicKey,
		counter: d.data().counter || 0,
		transports: d.data().transports || [],
		created_at: d.data().createdAt,
	}));
}

export async function getCredential(credId) {
	const db = await loadAdmin(config_holder);
	const doc = await db.collection("webauthn_credentials").doc(String(credId)).get();
	if (!doc.exists) return null;
	return {
		id: doc.id,
		email: doc.data().email,
		publicKey: doc.data().publicKey,
		counter: doc.data().counter || 0,
		transports: doc.data().transports || [],
		created_at: doc.data().createdAt,
	};
}

export async function addCredential(cred) {
	const db = await loadAdmin(config_holder);
	await db.collection("webauthn_credentials").doc(cred.id).set({
		email: cred.email,
		publicKey: cred.publicKey,
		counter: cred.counter || 0,
		transports: cred.transports || [],
		createdAt: Date.now(),
	});
	return cred;
}

export async function deleteCredential(credId) {
	const db = await loadAdmin(config_holder);
	const doc = await db.collection("webauthn_credentials").doc(String(credId)).get();
	if (!doc.exists) return false;
	await db.collection("webauthn_credentials").doc(String(credId)).delete();
	return true;
}

// ---- WebAuthn challenges (TTL enforced on read) ----------------------------

export async function saveChallenge(id, ch) {
	const db = await loadAdmin(config_holder);
	await db.collection("auth_challenges").doc(String(id)).set({
		payload: JSON.stringify(ch),
		expiry: ch.expiry || 0,
		ts: Date.now(),
	});
}

export async function getChallenge(id) {
	const db = await loadAdmin(config_holder);
	const doc = await db.collection("auth_challenges").doc(String(id)).get();
	if (!doc.exists) return null;
	const d = doc.data();
	if (d.expiry && d.expiry <= Date.now()) {
		await db.collection("auth_challenges").doc(String(id)).delete();
		return null;
	}
	return JSON.parse(d.payload);
}

export async function deleteChallenge(id) {
	const db = await loadAdmin(config_holder);
	const doc = await db.collection("auth_challenges").doc(String(id)).get();
	if (!doc.exists) return false;
	await db.collection("auth_challenges").doc(String(id)).delete();
	return true;
}

// ---- Audit log ---------------------------------------------------------------

export async function audit(entry) {
	const db = await loadAdmin(config_holder);
	await db.collection("admin_audit").add({
		ts: Date.now(),
		actor: entry.actor || "",
		method: entry.method || "",
		detail: entry.detail || "",
		ip: entry.ip || "",
	});
}

export async function listAudit(limit = 50) {
	const db = await loadAdmin(config_holder);
	const snap = await db.collection("admin_audit").orderBy("ts", "desc").limit(limit).get();
	return snap.docs.map((d) => d.data());
}

export async function close() {
	/* the platform manages the app lifecycle */
}

// The init() signature receives config, but the other methods don't. Keep a
// module-level reference set by init().
let config_holder = null;

export async function init(config) {
	config_holder = config;
	await loadAdmin(config);
}
