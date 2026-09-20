/**
 * tools/server/app.mjs — Framework-agnostic cloud API application.
 *
 * createApp(config) builds the whole application (routing, rate limiting,
 * logging, Ed25519 signing, admin UI) and returns { handler, storage, ... }.
 * The handler has the signature (req, res) and works identically on:
 *   - a plain node:http server     (see server.mjs — local mode)
 *   - a Vercel serverless function (see /api/index.js + /api/[...path].js)
 *   - a Firebase Cloud Function    (wrap with onRequest)
 *
 * No long-lived timers or global sockets live here: in serverless the
 * function is request-scoped, so registration expiry is self-healing
 * (expired entries are treated as absent and deleted on read) and the
 * periodic sweep is only an optimization for local mode (server.mjs).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { loadCloudKeys, signPayload } from "./crypto.mjs";
import { createStorage } from "./storage.mjs";
import * as auth from "./auth.mjs";
import { matchMdRoute, renderMarkdown } from "./markdown.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createApp(config) {
	// ---- cloud keypair (stable across requests; env-driven in serverless) --
	const cloudKeys = loadCloudKeys(config);

	// ---- storage (Firestore driver in serverless; local drivers otherwise) --
	const storage = await createStorage(config);

	// ---- admin token ---------------------------------------------------------
	const adminToken = config.ADMIN_TOKEN || crypto.randomBytes(16).toString("hex");
	const bootTime = Date.now();

	// ---- static assets -------------------------------------------------------
	// Frontend is split into separate HTML / CSS / JS files under public/
	// (login page, admin console, shared base styles, per-view scripts).
	// Everything is read once per instance; fine for function warm starts.
	const PUBLIC_DIR = path.join(__dirname, "..", "public");
	const STATIC_FILES = {
		"/": { file: "index.html", mime: "text/html; charset=utf-8" },
		"/login": { file: "login.html", mime: "text/html; charset=utf-8" },
		"/admin": { file: "admin.html", mime: "text/html; charset=utf-8" },
		"/css/base.css": { file: "css/base.css", mime: "text/css; charset=utf-8" },
		"/css/login.css": { file: "css/login.css", mime: "text/css; charset=utf-8" },
		"/css/admin.css": { file: "css/admin.css", mime: "text/css; charset=utf-8" },
		"/js/api.js": { file: "js/api.js", mime: "text/javascript; charset=utf-8" },
		"/js/login.js": { file: "js/login.js", mime: "text/javascript; charset=utf-8" },
		"/js/admin.js": { file: "js/admin.js", mime: "text/javascript; charset=utf-8" },
		"/css/legal.css": { file: "css/legal.css", mime: "text/css; charset=utf-8" },
		"/css/home.css": { file: "css/home.css", mime: "text/css; charset=utf-8" },
		"/js/legal.js": { file: "js/legal.js", mime: "text/javascript; charset=utf-8" },
		"/js/home.js": { file: "js/home.js", mime: "text/javascript; charset=utf-8" },
		"/favicon.png": { file: "favicon.png", mime: "image/png" },
		"/images/docs/teacher-console.png": { file: "images/docs/teacher-console.png", mime: "image/png" },
		"/images/docs/security-gate.png": { file: "images/docs/security-gate.png", mime: "image/png" },
		"/images/docs/student-share.png": { file: "images/docs/student-share.png", mime: "image/png" },
		"/images/docs/permission.png": { file: "images/docs/permission.png", mime: "image/png" },
	};
	const staticCache = {};
	for (const [pathname, info] of Object.entries(STATIC_FILES)) {
		staticCache[pathname] = fs.readFileSync(path.join(PUBLIC_DIR, info.file));
	}
	// Security headers on every static response (CSP is strict: only gstatic
	// for Firebase, everything else from self; no inline scripts anywhere).
	const STATIC_HEADERS = {
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"Content-Security-Policy": [
			"default-src 'self'",
			"script-src 'self' https://www.gstatic.com",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data:",
			"connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://*.googleapis.com",
			"frame-src 'self' https://accounts.google.com https://*.firebaseapp.com",
			"frame-ancestors 'none'",
			"base-uri 'self'",
			"form-action 'self'",
		].join("; "),
	};

	// ---- logging ------------------------------------------------------------
	let logStream = null;
	if (config.LOG_FILE) {
		try {
			fs.mkdirSync(path.dirname(config.LOG_FILE), { recursive: true });
			logStream = fs.createWriteStream(config.LOG_FILE, { flags: "a" });
		} catch (err) {
			console.warn(`[log] cannot open ${config.LOG_FILE}: ${err.message}`);
		}
	}
	function log(msg) {
		const line = `[${new Date().toISOString()}] ${msg}`;
		console.log(line);
		if (logStream) logStream.write(line + "\n");
	}

	// ---- helpers -------------------------------------------------------------
	const PRIVATE_RANGES = [
		{ name: "loopback", test: (p) => p === "127.0.0.1" || p === "::1" },
		{ name: "private-10", test: (p) => p.startsWith("10.") },
		{ name: "private-172", test: (p) => p.startsWith("172.") && /^172\.(1[6-9]|2\d|3[01])\./.test(p) },
		{ name: "private-192", test: (p) => p.startsWith("192.168.") },
		{ name: "cgNAT-100.64", test: (p) => p.startsWith("100.64.") },
		{ name: "link-local", test: (p) => p.startsWith("169.254.") },
		{ name: "ipv6-ula", test: (p) => p.startsWith("fd") || p.startsWith("fc") },
		{ name: "ipv6-linklocal", test: (p) => p.startsWith("fe80:") },
	];
	function isPrivateIp(ip) {
		return PRIVATE_RANGES.some((r) => r.test(ip));
	}
	function normalizeIp(ip) {
		if (!ip) return "";
		ip = ip.trim();
		if (ip.startsWith("::ffff:")) ip = ip.slice(7);
		return ip;
	}
	function publicIpOf(req) {
		const mode = config.PUBLIC_IP_MODE || "auto";
		if (mode === "loopback") return "127.0.0.1";
		if (mode === "local") return "127.0.0.1";
		// "auto": honor proxy headers, otherwise fall back to the socket address
		const xff = req.headers["x-forwarded-for"];
		if (xff) {
			const first = normalizeIp(String(xff).split(",")[0]);
			if (first) return first;
		}
		const real = req.headers["x-real-ip"];
		if (real) {
			const r = normalizeIp(String(real));
			if (r) return r;
		}
		return normalizeIp(req.socket.remoteAddress || "");
	}

	function json(res, status, obj, extraHeaders = {}) {
		const body = JSON.stringify(obj);
		res.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
			"Cache-Control": "no-store",
			...extraHeaders,
		});
		res.end(body);
	}

	function secureCookie(req) {
		return String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim() === "https";
	}

	function readBody(req, maxBytes = 65536) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			let size = 0;
			req.on("data", (c) => {
				size += c.length;
				if (size > maxBytes) {
					reject(new Error("payload too large"));
					req.destroy();
					return;
				}
				chunks.push(c);
			});
			req.on("end", () => {
				try {
					resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
				} catch {
					reject(new Error("invalid JSON body"));
				}
			});
			req.on("error", reject);
		});
	}

	// ---- rate limiting (per-instance; note: advisory only in serverless) -----
	const buckets = new Map();
	function rateLimit(key, windowMs, max) {
		const now = Date.now();
		let b = buckets.get(key);
		if (!b || now - b.start >= windowMs) {
			b = { start: now, count: 0 };
			buckets.set(key, b);
		}
		b.count++;
		if (b.count > max) {
			log(`rate-limit: ${key}`);
			return false;
		}
		if (buckets.size > 10000) buckets.clear();
		return true;
	}

	// ---- signatures ----------------------------------------------------------
	function signDiscovery(reg, ts) {
		const payload = {
			lanIp: reg.lanIp,
			signPub: reg.signPub,
			encPub: reg.encPub,
			schoolName: reg.schoolName || "",
			ts,
			expiresAt: reg.expiresAt,
		};
		if (reg.prevSignPub) {
			payload.prevSignPub = reg.prevSignPub;
			payload.prevEncPub = reg.prevEncPub;
			payload.prevSince = reg.prevSince;
		}
		const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
		return { payload: payloadB64, signature: signPayload(cloudKeys.signPriv, payloadB64) };
	}
	function signUpdate(u) {
		const plain = JSON.stringify({ version: u.version, url: u.url, sha256: u.sha256 });
		return { version: u.version, url: u.url, sha256: u.sha256, signature: signPayload(cloudKeys.signPriv, plain) };
	}

	// ---- API handlers --------------------------------------------------------
	async function handleRegister(body, ip) {
		const now = Date.now();
		const ttl = Math.max(Number(body.ttlMs) || config.REGISTRATION_TTL_MS, 1);
		if (typeof body.token !== "string" || body.token.length === 0) {
			return json(resolve_res, 400, { ok: false, error: "missing token" });
		}
		if (!body.lanIp || !isPrivateIp(normalizeIp(body.lanIp))) {
			return json(resolve_res, 400, { ok: false, error: "lanIp must be a private address" });
		}
		if (typeof body.signPub !== "string" || typeof body.encPub !== "string") {
			return json(resolve_res, 400, { ok: false, error: "missing public keys" });
		}
		if (!(await storage.tokenValid(body.token))) {
			return json(resolve_res, 401, { ok: false, error: "invalid registration token" });
		}
		let existing = await storage.getRegistration(ip);
		// Self-healing expiry: an expired registration is "absent", so a fresh
		// teacher with a valid token can take over the public IP (serverless
		// mode has no background sweeper to do this for us).
		if (existing && existing.expiresAt <= now) {
			log(`register: expired registration for ${ip} replaced`);
			await storage.deleteRegistration(ip);
			existing = null;
		}
		if (existing && existing.token !== body.token) {
			return json(resolve_res, 409, {
				ok: false,
				error: "public IP already registered by another admin (one school per public IP)",
			});
		}
		const expiresAt = now + ttl;
		// Key rotation: carry the previous keys into the grace window so that
		// clients still holding the old key can keep verifying for KEY_GRACE_MS.
		let prevSignPub = null;
		let prevEncPub = null;
		let prevSince = null;
		if (existing) {
			const keyChanged = existing.signPub !== body.signPub || existing.encPub !== body.encPub;
			if (keyChanged) {
				prevSignPub = existing.signPub;
				prevEncPub = existing.encPub;
				prevSince = now;
			} else if (existing.prevSignPub && now - existing.prevSince < config.KEY_GRACE_MS) {
				prevSignPub = existing.prevSignPub;
				prevEncPub = existing.prevEncPub;
				prevSince = existing.prevSince;
			}
		}
		const reg = {
			publicIp: ip,
			lanIp: normalizeIp(body.lanIp),
			signPub: body.signPub,
			encPub: body.encPub,
			prevSignPub,
			prevEncPub,
			prevSince,
			schoolName: String(body.info?.schoolName || "").slice(0, 120),
			token: body.token,
			registrationId: crypto.randomBytes(8).toString("hex"),
			ts: now,
			expiresAt,
			lastHeartbeat: now,
		};
		await storage.upsertRegistration(reg);
		log(`register: ${ip} → ${reg.schoolName || "unnamed"} (${reg.lanIp})`);
		return json(resolve_res, 200, {
			ok: true,
			registrationId: reg.registrationId,
			heartbeatMs: config.HEARTBEAT_MS,
			expiresInMs: ttl,
		});
	}

	async function handleUnregister(body, ip) {
		if (typeof body.token !== "string") {
			return json(resolve_res, 400, { ok: false, error: "missing token" });
		}
		const reg = await storage.getRegistration(ip);
		if (!reg || reg.token !== body.token) {
			return json(resolve_res, 200, { ok: true, removed: false });
		}
		await storage.deleteRegistration(ip);
		log(`unregister: ${ip}`);
		return json(resolve_res, 200, { ok: true, removed: true });
	}

	async function handleDiscover() {
		const ip = publicIpOf(current_req);
		const now = Date.now();
		const reg = await storage.getRegistration(ip);
		if (!reg) return json(resolve_res, 204, "");
		// Lazy expiry: expired registrations are deleted and reported as absent.
		if (reg.expiresAt <= now) {
			await storage.deleteRegistration(ip);
			return json(resolve_res, 204, "");
		}
		return json(resolve_res, 200, signDiscovery(reg, now));
	}

	async function handleUpdate() {
		const u = await storage.getCurrentUpdate();
		if (!u) return json(resolve_res, 404, { ok: false, error: "no update manifest" });
		return json(resolve_res, 200, signUpdate(u));
	}

	async function handleHealth() {
		return json(resolve_res, 200, {
			ok: true,
			service: "inhand-cloud",
			time: Date.now(),
			uptimeMs: Date.now() - bootTime,
			storage: storage.name,
		});
	}

	// ---- admin handlers ------------------------------------------------------
	function adminOk(res) {
		return json(res, 200, { ok: true });
	}
	/**
	 * Dual-channel admin authorization:
	 *   1. session cookie (passkey / Google / dev-token) — the modern path,
	 *   2. legacy X-Admin-Token header (or ?adminToken=) — kept for CLI, tests
	 *      and first-run bootstrap; audited when used.
	 */
	async function adminSession(req) {
		const header = String(req.headers["x-admin-token"] || "");
		const query = String(req.query?.adminToken || "");
		if (header && header === adminToken) {
			return { uid: "", email: "dev-token", auth: "devtoken", viaHeader: true };
		}
		if (query && query === adminToken) {
			return { uid: "", email: "dev-token", auth: "devtoken", viaHeader: true };
		}
		return auth.readSessionCookie(config, req);
	}
	async function adminRequireAuth(req, res, fn) {
		const session = await adminSession(req);
		if (!session) {
			return json(res, 401, { ok: false, error: "unauthorized" });
		}
		req.adminSession = session;
		return fn(res, req);
	}
	async function audit(actor, method, detail, req) {
		try {
			await storage.audit({
				actor: (actor && actor.email) || "dev-token",
				method,
				detail,
				ip: publicIpOf(req || current_req),
			});
		} catch (err) {
			log(`audit-write-failed: ${err.message}`);
		}
	}
	async function adminTokens(res) {
		return json(res, 200, { ok: true, tokens: await storage.listTokens() });
	}
	async function adminCreateToken(res, body) {
		const token = await storage.createToken(String(body?.label || "manual"));
		await audit(current_req.adminSession, "tokens.create", `label=${body?.label || "manual"}`, current_req);
		return json(res, 200, { ok: true, token });
	}
	async function adminRevokeToken(res, body) {
		const removed = await storage.revokeToken(String(body?.token || ""));
		await audit(current_req.adminSession, "tokens.revoke", `token=${String(body?.token || "").slice(0, 12)}…`, current_req);
		return json(res, 200, { ok: true, revoked: removed });
	}
	async function adminRegistrations(res) {
		return json(res, 200, { ok: true, registrations: await storage.listRegistrations() });
	}
	async function adminDeleteRegistration(res, ip) {
		const removed = await storage.deleteRegistration(ip);
		await audit(current_req.adminSession, "registrations.delete", `ip=${ip}`, current_req);
		return json(res, 200, { ok: true, removed });
	}
	async function adminUpdates(res) {
		return json(res, 200, { ok: true, updates: await storage.listUpdates() });
	}
	async function adminPublishUpdate(res, body) {
		const v = String(body?.version || "");
		const url = String(body?.url || "");
		const sha = String(body?.sha256 || "");
		if (!v || !url || !sha) {
			return json(res, 400, { ok: false, error: "version, url, sha256 required" });
		}
		const id = await storage.publishUpdate({ version: v, url, sha256: sha, platform: body.platform || "mac-arm64" });
		await audit(current_req.adminSession, "updates.publish", `version=${v} platform=${body.platform || "mac-arm64"}`, current_req);
		return json(res, 200, { ok: true, id });
	}
	async function adminDeleteUpdate(res, id) {
		if (!id) return json(res, 400, { ok: false, error: "id required" });
		const removed = await storage.deleteUpdate(id);
		await audit(current_req.adminSession, "updates.delete", `id=${id}`, current_req);
		return json(res, 200, { ok: true, deleted: removed });
	}
	async function adminStats(res) {
		return json(res, 200, {
			ok: true,
			...((await storage.stats()) || {}),
			config: {
				cloudPub: cloudKeys.signPub,
				cloudEncPub: cloudKeys.encPub,
				storage: storage.name,
				driver: storage.name,
			},
		});
	}
	async function adminSweep(res) {
		const removed = await storage.sweepExpired(Date.now());
		return json(res, 200, { ok: true, removed });
	}

	// ---- auth handlers (Google / passkey / dev-token sessions) ----------------
	async function authMe(res, req) {
		const s = await adminSession(req);
		let hasAdmins = false;
		try {
			const admins = await storage.listAdmins();
			hasAdmins = Array.isArray(admins) && admins.length > 0;
		} catch {}
		return json(res, 200, {
			ok: true,
			authenticated: !!s,
			session: s ? { email: s.email, auth: s.auth } : null,
			allowEmailPassword: !!config.ALLOW_EMAIL_PASSWORD,
			hasAdmins,
		});
	}
	async function authLogout(res, req) {
		await audit(req.adminSession, "auth.logout", "", req);
		return json(
			res,
			200,
			{ ok: true },
			{ "Set-Cookie": `${auth.SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` },
		);
	}
	async function authDevToken(res, req) {
		const body = req.body || {};
		if (String(body.token || "") !== adminToken) {
			return json(res, 401, { ok: false, error: "invalid dev token" });
		}
		const session = auth.makeSession(config, { uid: "", email: "dev-token", auth: "devtoken" });
		await audit(session, "auth.devtoken", "dev-token sign-in", req);
		return json(
			res,
			200,
			{ ok: true, session: { email: "dev-token", auth: "devtoken" } },
			{ "Set-Cookie": auth.cookieFor(session.token, secureCookie(req)) },
		);
	}
	async function authGoogle(res, req) {
		const body = req.body || {};
		try {
			const identity = await auth.firebaseLogin(config, storage, body.idToken);
			const session = auth.makeSession(config, identity);
			await audit(identity, "auth.google", `email=${identity.email}`, req);
			return json(
				res,
				200,
				{ ok: true, session: { email: identity.email, auth: identity.auth } },
				{ "Set-Cookie": auth.cookieFor(session.token, secureCookie(req)) },
			);
		} catch (e) {
			await audit({ email: "?" }, "auth.google.fail", e.message, req);
			return json(res, 401, { ok: false, error: e.message });
		}
	}
	async function authPasskeyRegisterOptions(res, req) {
		const s = await adminSession(req);
		if (!s) return json(res, 401, { ok: false, error: "unauthorized" });
		// A passkey must be bound to the signed-in admin's own account.
		const email = String(req.body?.email || s.email || "").toLowerCase();
		if (s.auth !== "devtoken" && email !== s.email) {
			return json(res, 403, { ok: false, error: "passkey must be bound to your own account" });
		}
		const admin = await storage.getAdminByEmail(email);
		if (!admin) return json(res, 403, { ok: false, error: "email is not an allowlisted admin" });
		try {
			const options = await auth.passkeyRegisterOptions(config, storage, req, admin);
			return json(res, 200, options);
		} catch (e) {
			return json(res, 400, { ok: false, error: e.message });
		}
	}
	async function authPasskeyRegisterVerify(res, req) {
		try {
			const r = await auth.passkeyRegisterVerify(config, storage, req, req.body);
			await audit(req.adminSession, "auth.passkey.register", `credential=${String(r.credentialId).slice(0, 12)}…`, req);
			return json(res, 200, r);
		} catch (e) {
			return json(res, 400, { ok: false, error: e.message });
		}
	}
	async function authPasskeyLoginOptions(res, req) {
		try {
			const options = await auth.passkeyLoginOptions(config, storage, req);
			return json(res, 200, options);
		} catch (e) {
			return json(res, 400, { ok: false, error: e.message });
		}
	}
	async function authPasskeyLoginVerify(res, req) {
		try {
			const identity = await auth.passkeyLoginVerify(config, storage, req.body);
			const session = auth.makeSession(config, identity);
			await audit(identity, "auth.passkey.login", `email=${identity.email}`, req);
			return json(
				res,
				200,
				{ ok: true, session: { email: identity.email, auth: identity.auth } },
				{ "Set-Cookie": auth.cookieFor(session.token, secureCookie(req)) },
			);
		} catch (e) {
			return json(res, 401, { ok: false, error: e.message });
		}
	}
	// ---- auth: admin allowlist / credentials / audit (session required) -------
	async function authAdminsList(res, req) {
		return json(res, 200, { ok: true, admins: await storage.listAdmins() });
	}
	async function authAdminsAdd(res, req) {
		const email = String(req.body?.email || "").trim().toLowerCase();
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
			return json(res, 400, { ok: false, error: "invalid email" });
		}
		const admin = await storage.addAdmin({ email, uid: "" });
		await audit(req.adminSession, "admins.add", `email=${email}`, req);
		return json(res, 200, { ok: true, admin });
	}
	async function authAdminsRemove(res, req, email) {
		const removed = await storage.removeAdmin(email);
		await audit(req.adminSession, "admins.remove", `email=${String(email).toLowerCase()}`, req);
		return json(res, 200, { ok: true, removed });
	}
	async function authCredentialsList(res, req) {
		return json(res, 200, { ok: true, credentials: await storage.listCredentials() });
	}
	async function authCredentialDelete(res, req, id) {
		const removed = await storage.deleteCredential(id);
		await audit(req.adminSession, "auth.passkey.remove", `credential=${String(id).slice(0, 12)}…`, req);
		return json(res, 200, { ok: true, removed });
	}
	async function authAuditList(res, req) {
		return json(res, 200, { ok: true, audit: await storage.listAudit(100) });
	}

	// ---- router ---------------------------------------------------------------
	// current_req / resolve_res: because Vercel invokes the handler per request,
	// these module-closure references are request-scoped (see handler below).
	let current_req = null;
	let resolve_res = null;

	function matchRoute(pathname) {
		const parts = pathname.split("/").filter(Boolean);
		if (parts[0] === "api" && parts[1] === "v1") {
			const rest = parts.slice(2).join("/");
			const map = {
				"admin/register": { m: "POST", h: () => handleRegister(current_req.body, publicIpOf(current_req)) },
				"admin/unregister": { m: "POST", h: () => handleUnregister(current_req.body, publicIpOf(current_req)) },
				discover: { m: "GET", h: handleDiscover },
				update: { m: "GET", h: handleUpdate },
				health: { m: "GET", h: handleHealth },
			};
			const entry = map[rest];
			if (entry) {
				if (current_req.method !== entry.m) {
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				return { handler: entry.h };
			}
			// admin management routes (path-parameter aware, matches the
			// original contract used by the admin UI, tests and interop):
			//   GET/POST admin/tokens | GET admin/registrations |
			//   DELETE admin/registrations/<ip> | GET/POST admin/updates |
			//   DELETE admin/updates/<id> | GET admin/stats | POST admin/sweep
			const segs = rest.split("/"); // e.g. ["admin","registrations","127.0.0.1"]
			// auth routes (Cloud Admin sessions)
			//   GET/POST …/auth/me, POST …/auth/logout|devtoken|google,
			//   POST …/auth/passkey/{register,login}/{options,verify},
			//   GET/POST …/auth/admins, DELETE …/auth/admins/<email>,
			//   GET …/auth/credentials, DELETE …/auth/credentials/<id>,
			//   GET …/auth/audit
			if (segs[0] === "auth") {
				const kind = segs[1];
				const param = segs[2];
				const okMethod = (m) => current_req.method === m;
				if (kind === "me" && !param && okMethod("GET")) return { handler: () => authMe(resolve_res, current_req) };
				if (kind === "logout" && !param && okMethod("POST")) {
					return { handler: () => adminRequireAuth(current_req, resolve_res, authLogout) };
				}
				if (kind === "devtoken" && !param && okMethod("POST")) return { handler: () => authDevToken(resolve_res, current_req) };
				if (kind === "google" && !param && okMethod("POST")) return { handler: () => authGoogle(resolve_res, current_req) };
				if (kind === "passkey" && segs.length === 4) {
					const sub = segs[2];
					const op = segs[3];
					if (sub === "register" && op === "options" && okMethod("POST")) return { handler: () => authPasskeyRegisterOptions(resolve_res, current_req) };
					if (sub === "register" && op === "verify" && okMethod("POST")) {
						return { handler: () => adminRequireAuth(current_req, resolve_res, authPasskeyRegisterVerify) };
					}
					if (sub === "login" && op === "options" && okMethod("POST")) return { handler: () => authPasskeyLoginOptions(resolve_res, current_req) };
					if (sub === "login" && op === "verify" && okMethod("POST")) return { handler: () => authPasskeyLoginVerify(resolve_res, current_req) };
					return { status: 404, body: { ok: false, error: "not found" } };
				}
				if (kind === "admins" && !param) {
					if (okMethod("GET")) return { handler: () => adminRequireAuth(current_req, resolve_res, authAdminsList) };
					if (okMethod("POST")) return { handler: () => adminRequireAuth(current_req, resolve_res, authAdminsAdd) };
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				if (kind === "admins" && param) {
					if (okMethod("DELETE")) return { handler: () => adminRequireAuth(current_req, resolve_res, (res, req) => authAdminsRemove(res, req, param)) };
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				if (kind === "credentials" && !param) {
					if (okMethod("GET")) return { handler: () => adminRequireAuth(current_req, resolve_res, authCredentialsList) };
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				if (kind === "credentials" && param) {
					if (okMethod("DELETE")) return { handler: () => adminRequireAuth(current_req, resolve_res, (res, req) => authCredentialDelete(res, req, param)) };
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				if (kind === "audit" && !param) {
					if (okMethod("GET")) return { handler: () => adminRequireAuth(current_req, resolve_res, authAuditList) };
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				return { status: 404, body: { ok: false, error: "not found" } };
			}
			// admin management routes (path-parameter aware, matches the
			// original contract used by the admin UI, tests and interop):
			//   GET/POST admin/tokens | GET admin/registrations |
			//   DELETE admin/registrations/<ip> | GET/POST admin/updates |
			//   DELETE admin/updates/<id> | GET admin/stats | POST admin/sweep
			if (segs[0] === "admin" && segs.length <= 3) {
				const kind = segs[1];
				const param = segs[2];
				const okMethod = (m) => current_req.method === m;
				if (kind === "tokens" && !param) {
					if (okMethod("GET")) return { handler: () => adminRequireAuth(current_req, resolve_res, adminTokens) };
					if (okMethod("POST")) return { handler: () => adminRequireAuth(current_req, resolve_res, (res) => adminCreateToken(res, current_req.body)) };
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				if (kind === "stats" && !param) {
					if (okMethod("GET")) return { handler: () => adminRequireAuth(current_req, resolve_res, adminStats) };
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				if (kind === "registrations" && !param) {
					if (okMethod("GET")) return { handler: () => adminRequireAuth(current_req, resolve_res, adminRegistrations) };
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				if (kind === "registrations" && param) {
					if (okMethod("DELETE")) return { handler: () => adminRequireAuth(current_req, resolve_res, (res) => adminDeleteRegistration(res, param)) };
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				if (kind === "updates" && !param) {
					if (okMethod("GET")) return { handler: () => adminRequireAuth(current_req, resolve_res, adminUpdates) };
					if (okMethod("POST")) return { handler: () => adminRequireAuth(current_req, resolve_res, (res) => adminPublishUpdate(res, current_req.body)) };
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				if (kind === "updates" && param) {
					if (okMethod("DELETE")) return { handler: () => adminRequireAuth(current_req, resolve_res, (res) => adminDeleteUpdate(res, param)) };
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				if (kind === "sweep" && !param) {
					if (okMethod("POST")) return { handler: () => adminRequireAuth(current_req, resolve_res, adminSweep) };
					return { status: 405, body: { ok: false, error: "method not allowed" } };
				}
				return { status: 404, body: { ok: false, error: "not found" } };
			}
			return { status: 404, body: { ok: false, error: "not found" } };
		}
		if (staticCache[pathname]) {
			return { staticFile: pathname };
		}
		// Public Markdown pages (configurable mounts, see markdown.mjs MD_ROUTES):
		//   /legal, /legal/privacy, /blogs/example-usage, …
		const mdMatch = matchMdRoute(pathname);
		if (mdMatch && current_req.method === "GET") {
			const { cfg, subpath } = mdMatch;
			return { handler: () => renderMarkdown(resolve_res, cfg, subpath) };
		}
		if (pathname === "/healthz") {
			return { handler: handleHealth };
		}
		return { status: 404, body: { ok: false, error: "not found" } };
	}

	async function handler(req, res) {
		current_req = req;
		resolve_res = res;
		let url;
		try {
			url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		} catch {
			return json(res, 400, { ok: false, error: "bad url" });
		}
		req.query = Object.fromEntries(url.searchParams.entries());

		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
				"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
			});
			return res.end();
		}

		if (!rateLimit(publicIpOf(req), config.RATE_LIMIT_WINDOW_MS, config.RATE_LIMIT_MAX)) {
			return json(res, 429, { ok: false, error: "rate limited" });
		}

		const route = matchRoute(url.pathname);
		try {
			if (route.staticFile) {
				res.writeHead(200, { "Content-Type": STATIC_FILES[route.staticFile].mime, ...STATIC_HEADERS });
				return res.end(staticCache[route.staticFile]);
			}
			if (route.handler) {
				if (req.method === "POST" && url.pathname.includes("/api/v1/")) {
					try {
						req.body = await readBody(req);
					} catch (e) {
						return json(res, 400, { ok: false, error: e.message });
					}
				} else {
					req.body = {};
				}
				return await route.handler();
			}
			return json(res, route.status, route.body);
		} catch (err) {
			log(`error: ${err.stack || err.message}`);
			if (!res.headersSent) return json(res, 500, { ok: false, error: "internal error" });
		}
	}

	return { handler, storage, cloudKeys, adminToken, config, log, sweep: () => storage.sweepExpired(Date.now()) };
}
