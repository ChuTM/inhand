/**
 * tools/server/auth.mjs — Admin authentication: sessions, WebAuthn passkeys
 * and Firebase (Google) sign-in.
 *
 * Three ways an admin gets a session:
 *   1. passkey  — WebAuthn assertion verified with @simplewebauthn/server.
 *                 The credential must belong to an allowlisted admin email.
 *   2. google   — Firebase ID token whose sign-in provider is "google.com"
 *                 (email/password is rejected unless ALLOW_EMAIL_PASSWORD).
 *   3. devtoken — the legacy ADMIN_TOKEN, used ONLY for first-run bootstrap
 *                 and local debugging. Audited separately.
 *
 * The session is an HMAC-signed, expiring cookie (HttpOnly, SameSite=Strict).
 * Admin API routes accept either the session cookie or the legacy
 * X-Admin-Token header (see app.mjs).
 */

import crypto from "crypto";

// ---- Session (HMAC-signed token) -------------------------------------------

const SESSION_COOKIE = "ih_admin";

export function signSession(config, payload) {
	const secret = config.SESSION_SECRET || "";
	if (!secret) throw new Error("SESSION_SECRET is not configured; sessions are disabled");
	const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString("base64url");
	const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
	return `${body}.${sig}`;
}

export function verifySession(config, token) {
	if (!token) return null;
	const secret = config.SESSION_SECRET || "";
	if (!secret) return null; // fail closed when the secret is missing
	const parts = String(token).split(".");
	if (parts.length !== 2) return null;
	const [body, sig] = parts;
	const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
	if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
	let payload;
	try {
		payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (!payload.exp || payload.exp <= Date.now()) return null;
	return payload;
}

export function makeSession(config, { uid, email, auth }) {
	const exp = Date.now() + config.SESSION_TTL_MS;
	return { token: signSession(config, { uid, email, auth, exp }), exp };
}

export function cookieFor(token, secure) {
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${24 * 60 * 60 * 2}${
		secure ? "; Secure" : ""
	}`;
}

export function readSessionCookie(config, req) {
	const header = String(req.headers.cookie || "");
	const m = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
	return verifySession(config, m ? m[1] : null);
}

// ---- WebAuthn helpers --------------------------------------------------------

function rpInfo(config, req) {
	const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
	const host = String(req.headers.host || "").split(":")[0];
	const origin = `${proto}://${host}`;
	// Any http origin on loopback hosts is accepted (local dev / tests run on
	// dynamic ports); remote origins must be in the explicit allowlist.
	const isLoopback = (host === "localhost" || host === "127.0.0.1") && proto === "http";
	if (!isLoopback) {
		const allowed = String(config.RP_ORIGINS || "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (!allowed.includes(origin)) {
			throw new Error(`origin ${origin} is not allowed for WebAuthn`);
		}
	}
	const rpID = isLoopback ? "localhost" : config.RP_ID;
	return { origin, rpID };
}

function b64url(s) {
	return Buffer.from(s).toString("base64url");
}

// ---- Challenge helpers --------------------------------------------------------

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export async function newChallenge(storage, kind, extra = {}) {
	const id = crypto.randomBytes(32).toString("base64url");
	await storage.saveChallenge(id, {
		kind,
		...extra,
		expiry: Date.now() + CHALLENGE_TTL_MS,
	});
	return id;
}

export async function takeChallenge(storage, id, kind) {
	const ch = await storage.getChallenge(id);
	if (!ch) return null;
	await storage.deleteChallenge(id);
	if (ch.kind !== kind) return null;
	return ch;
}

// ---- Passkey registration -----------------------------------------------------

export async function passkeyRegisterOptions(config, storage, req, admin) {
	const { origin, rpID } = rpInfo(config, req);
	const { generateRegistrationOptions } = await import("@simplewebauthn/server");
	const existing = (await storage.listCredentials()).filter((c) => c.email === admin.email);
	const options = await generateRegistrationOptions({
		rpName: "InHand Cloud Admin",
		rpID,
		userID: new TextEncoder().encode(admin.email),
		userName: admin.email,
		userDisplayName: admin.email,
		timeout: 120000,
		attestationType: "none",
		excludeCredentials: existing.map((c) => ({
			id: c.id,
			transports: c.transports || [],
		})),
		authenticatorSelection: {
			residentKey: "required",
			userVerification: "required",
		},
	});
	const challengeId = await newChallenge(storage, "register", {
		email: admin.email,
		rpID,
		origin,
		expected: options.challenge,
	});
	return { ...options, challengeId, rpID, origin };
}

export async function passkeyRegisterVerify(config, storage, req, body) {
	const challengeId = String(body?.challengeId || "");
	const ch = await takeChallenge(storage, challengeId, "register");
	if (!ch) throw new Error("challenge expired or not found");
	const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
	const verification = await verifyRegistrationResponse({
		response: body.response,
		expectedChallenge: ch.expected,
		expectedOrigin: ch.origin,
		expectedRPID: ch.rpID,
		requireUserVerification: true,
	});
	if (!verification.verified || !verification.registrationInfo) {
		throw new Error("passkey registration failed verification");
	}
	const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
	await storage.addCredential({
		id: credential.id,
		email: ch.email,
		publicKey: b64url(credential.publicKey),
		counter: credential.counter,
		transports: body.response.transports || [],
	});
	return {
		ok: true,
		credentialId: credential.id,
		deviceType: credentialDeviceType,
		backedUp: credentialBackedUp,
	};
}

// ---- Passkey login -------------------------------------------------------------

export async function passkeyLoginOptions(config, storage, req) {
	const { origin, rpID } = rpInfo(config, req);
	const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
	const creds = await storage.listCredentials();
	const options = await generateAuthenticationOptions({
		rpID,
		timeout: 120000,
		allowCredentials: creds.map((c) => ({
			id: c.id,
			type: "public-key",
			transports: c.transports || [],
		})),
		userVerification: "required",
	});
	const challengeId = await newChallenge(storage, "login", {
		rpID,
		origin,
		expected: options.challenge,
	});
	return { ...options, challengeId, rpID, origin };
}

export async function passkeyLoginVerify(config, storage, body) {
	const challengeId = String(body?.challengeId || "");
	const ch = await takeChallenge(storage, challengeId, "login");
	if (!ch) throw new Error("challenge expired or not found");
	const cred = await storage.getCredential(body?.response?.id);
	if (!cred) throw new Error("unknown passkey credential");
	const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
	const verification = await verifyAuthenticationResponse({
		response: body.response,
		expectedChallenge: ch.expected,
		expectedOrigin: ch.origin,
		expectedRPID: ch.rpID,
		requireUserVerification: true,
		credential: {
			id: cred.id,
			publicKey: Uint8Array.from(Buffer.from(cred.publicKey, "base64url")),
			counter: cred.counter,
		},
	});
	if (!verification.verified) throw new Error("passkey assertion failed");
	if (verification.authenticationInfo.newCounter > 0) {
		await storage.addCredential({ ...cred, counter: verification.authenticationInfo.newCounter });
	}
	const admin = await storage.getAdminByEmail(cred.email);
	if (!admin) throw new Error("passkey owner is not an allowlisted admin");
	return { uid: admin.uid || "", email: admin.email, auth: "passkey" };
}

// ---- Firebase (Google / email-password) ------------------------------------------

/**
 * Verifies a Firebase ID token and enforces the policy:
 *   - sign-in provider must be "google.com" (email/password is rejected
 *     unless config.ALLOW_EMAIL_PASSWORD is true),
 *   - the email must be verified by the provider,
 *   - the email must be in the allowlist (storage or ALLOWED_ADMIN_EMAILS).
 *
 * verifyIdToken is injectable for tests.
 */
export async function firebaseLogin(config, storage, idToken, opts = {}) {
	const verify = opts.verifyIdToken || (async (token) => {
		const { default: admin } = await import("firebase-admin");
		if (!admin.apps || admin.apps.length === 0) {
			const { getCredentials } = await import("./drivers/firestore.mjs");
			// keep the same credential source as the firestore driver
			admin.initializeApp({ credential: admin.credential.cert(getCredentials(config)) });
		}
		return admin.auth().verifyIdToken(token);
	});
	const decoded = await verify(String(idToken || ""));
	const email = String(decoded.email || "").toLowerCase();
	if (!decoded.email_verified) throw new Error("email is not verified");
	const provider = (decoded.firebase && decoded.firebase.sign_in_provider) || "unknown";
	if (provider === "password" && !config.ALLOW_EMAIL_PASSWORD) {
		throw new Error("email/password sign-in is temporarily disabled");
	}
	const stored = await storage.getAdminByEmail(email);
	const envList = String(config.ALLOWED_ADMIN_EMAILS || "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (!stored && !envList.includes(email)) {
		throw new Error("email is not an allowlisted admin");
	}
	if (!stored) {
		await storage.addAdmin({ email, uid: decoded.uid });
	}
	return { uid: decoded.uid, email, auth: provider };
}

// ---- Helpers shared with app.mjs ------------------------------------------------

export { SESSION_COOKIE };
