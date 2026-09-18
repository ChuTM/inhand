/**
 * tools/server/test.mjs — End-to-end test of the cloud server.
 *
 * Boots the real server (memory driver) on a free port and exercises the full
 * public + admin API over HTTP: tokens, register/heartbeat/409, key rotation,
 * discover signature verification, unregister, update manifests, expiry.
 *
 * Run: node test.mjs   (or: npm test)
 */
import { spawn } from "child_process";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { generateKeyPair, verifyPayload } from "../src/crypto.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_TOKEN = "test-admin-token";
let passed = 0;
let failed = 0;

function ok(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  PASS  ${name}`);
	} else {
		failed++;
		console.log(`  FAIL  ${name} ${extra}`);
	}
}

function freePort() {
	return new Promise((resolve, reject) => {
		const s = net.createServer();
		s.listen(0, "127.0.0.1", () => {
			const port = s.address().port;
			s.close(() => resolve(port));
		});
		s.on("error", reject);
	});
}

function bootServer(overrides = {}) {
	return new Promise(async (resolve) => {
		const port = await freePort();
		const keysFile = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "wg-server-")),
			"cloud-keys.json",
		);
		const child = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
			cwd: __dirname,
			env: {
				...process.env,
				HOST: "127.0.0.1",
				PORT: String(port),
				STORAGE_DRIVER: process.env.WG_TEST_DRIVER || "memory",
				KEYS_FILE: keysFile,
				ADMIN_TOKEN,
				VERBOSE: "false",
				SWEEP_INTERVAL_MS: "200",
				PUBLIC_IP_MODE: "socket",
				REGISTRATION_TTL_MS: String(60_000),
				SESSION_SECRET: "test-session-secret",
				ALLOW_EMAIL_PASSWORD: "false",
				...overrides,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const wait = setInterval(() => {
			if (out.includes("Listening on")) {
				clearInterval(wait);
				resolve({ port, child, keysFile, out });
			}
		}, 30);
		setTimeout(() => {
			clearInterval(wait);
			resolve({ port, child, keysFile, out });
		}, 5000);
	});
}

function api(port, pathname, { method = "GET", body, token } = {}) {
	return fetch(`http://127.0.0.1:${port}${pathname}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			...(token ? { "X-Admin-Token": token } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function wait(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

const server = await bootServer();
const { port } = server;
const base = "/api/v1";
const cloudPub = (await (await api(port, `${base}/admin/stats`, { token: ADMIN_TOKEN })).json()).config.cloudPub;

console.log(`\nCloud server e2e (port ${port}, driver memory)\n`);

// ---- public surface --------------------------------------------------------
const kp = generateKeyPair();

{
	const r = await api(port, `${base}/health`);
	const j = await r.json();
	ok("health endpoint", r.status === 200 && j.ok === true);
}

{
	const r = await api(port, `${base}/discover`);
	ok("discover with no registration -> 204", r.status === 204);
}

{
	const r = await api(port, `${base}/admin/register`, { method: "POST", body: { token: "nope", lanIp: "192.168.1.5", signPub: kp.signPub, encPub: kp.encPub } });
	ok("register with invalid token -> 401", r.status === 401);
}

{
	const r = await api(port, `${base}/admin/register`, { method: "POST", body: { token: "x", lanIp: "8.8.8.8", signPub: "x", encPub: "y" } });
	ok("register with public lanIp -> 400", r.status === 400);
}

// ---- admin auth ------------------------------------------------------------
{
	const r = await api(port, `${base}/admin/tokens`);
	ok("admin list without token -> 401", r.status === 401);
}
{
	const r = await api(port, `${base}/admin/tokens`, { token: "wrong" });
	ok("admin list with wrong token -> 401", r.status === 401);
}
{
	const r = await api(port, `${base}/admin/stats`, { token: ADMIN_TOKEN });
	ok("admin stats with token -> 200", r.status === 200);
}

// ---- tokens + registration -------------------------------------------------
const schoolToken = (
	await (await api(port, `${base}/admin/tokens`, { method: "POST", token: ADMIN_TOKEN, body: { label: "School of Physics" } })).json()
).token;
ok("admin creates registration token", typeof schoolToken === "string" && schoolToken.length >= 32);

const regBody = {
	token: schoolToken,
	lanIp: "192.168.1.5",
	signPub: kp.signPub,
	encPub: kp.encPub,
	info: { schoolName: "School of Physics" },
};

{
	const r = await api(port, `${base}/admin/register`, { method: "POST", body: regBody });
	const j = await r.json();
	ok("register ok", r.status === 200 && j.ok === true && j.registrationId && j.heartbeatMs > 0 && j.expiresInMs > 0);
}

{
	const r = await api(port, `${base}/discover`);
	const j = await r.json();
	const payload = JSON.parse(Buffer.from(j.payload, "base64").toString("utf8"));
	ok("discover returns signed payload", r.status === 200 && payload.lanIp === "192.168.1.5" && payload.signPub === kp.signPub && payload.schoolName === "School of Physics");
	ok("discover signature verifies with cloud pub", verifyPayload(cloudPub, j.payload, j.signature));
}

{
	const r = await api(port, `${base}/admin/register`, { method: "POST", body: regBody });
	const j = await r.json();
	ok("heartbeat re-register keeps id", r.status === 200 && j.registrationId !== undefined);
}

{
	const r2 = await api(port, `${base}/admin/tokens`, { method: "POST", token: ADMIN_TOKEN, body: { label: "Rival" } });
	const other = (await r2.json()).token;
	const r = await api(port, `${base}/admin/register`, { method: "POST", body: { ...regBody, token: other } });
	ok("second teacher on same public IP -> 409", r.status === 409);
}

// ---- key rotation ----------------------------------------------------------
{
	const kp2 = generateKeyPair();
	await api(port, `${base}/admin/register`, { method: "POST", body: { ...regBody, signPub: kp2.signPub, encPub: kp2.encPub } });
	const j = await (await api(port, `${base}/discover`)).json();
	const payload = JSON.parse(Buffer.from(j.payload, "base64").toString("utf8"));
	ok("rotation: discover returns new key", payload.signPub === kp2.signPub);
	ok("rotation: previous key exposed in grace window", payload.prevSignPub === kp.signPub && payload.prevEncPub === kp.encPub);
}

// ---- admin registrations ---------------------------------------------------
{
	const j = await (await api(port, `${base}/admin/registrations`, { token: ADMIN_TOKEN })).json();
	ok("admin lists registration", j.registrations.length === 1 && j.registrations[0].publicIp === "127.0.0.1");
}

{
	const r = await api(port, `${base}/admin/registrations/127.0.0.1`, { method: "DELETE", token: ADMIN_TOKEN });
	ok("admin force-removes registration", r.status === 200);
	const d = await api(port, `${base}/discover`);
	ok("discover 204 after force-remove", d.status === 204);
}

// ---- unregister ------------------------------------------------------------
{
	await api(port, `${base}/admin/register`, { method: "POST", body: regBody });
	const r = await api(port, `${base}/admin/unregister`, { method: "POST", body: { token: schoolToken } });
	ok("unregister ok", r.status === 200);
	const d = await api(port, `${base}/discover`);
	ok("discover 204 after unregister", d.status === 204);
}

// ---- update manifests ------------------------------------------------------
{
	const r = await api(port, `${base}/update`);
	ok("update with no manifest -> 404", r.status === 404);
}

const manifest = { version: "2.1.0", url: "https://example.com/InHand-arm64.dmg", sha256: "a".repeat(64) };
{
	const r = await api(port, `${base}/admin/updates`, { method: "POST", token: ADMIN_TOKEN, body: manifest });
	ok("admin publishes update", r.status === 200 && (await r.json()).id === 1);
}

{
	const j = await (await api(port, `${base}/update`)).json();
	ok("update returns signed manifest", j.version === manifest.version && j.url === manifest.url && j.sha256 === manifest.sha256);
	ok("update signature verifies over {version,url,sha256}", verifyPayload(cloudPub, JSON.stringify({ version: j.version, url: j.url, sha256: j.sha256 }), j.signature));
}

{
	const j = await (await api(port, `${base}/admin/updates`, { token: ADMIN_TOKEN })).json();
	ok("admin lists update", j.updates.length === 1);
}

{
	const r = await api(port, `${base}/admin/updates/1`, { method: "DELETE", token: ADMIN_TOKEN });
	ok("admin deletes update", r.status === 200);
	const d = await api(port, `${base}/update`);
	ok("update 404 after delete", d.status === 404);
}

// ---- expiry (short-TTL boot) ------------------------------------------------
{
	const server2 = await bootServer({ REGISTRATION_TTL_MS: "500" });
	const t2 = (await (await api(server2.port, `${base}/admin/tokens`, { method: "POST", token: ADMIN_TOKEN, body: { label: "expiry" } })).json()).token;
	await api(server2.port, `${base}/admin/register`, { method: "POST", body: { ...regBody, token: t2 } });
	ok("short-TTL boot: discover before expiry", (await api(server2.port, `${base}/discover`)).status === 200);
	await wait(900);
	ok("short-TTL boot: discover 204 after expiry", (await api(server2.port, `${base}/discover`)).status === 204);
	server2.child.kill("SIGTERM");
}


// ---- admin sessions (dev-token bootstrap + cookie auth) --------------------
let sessionCookie = "";
function cookieFrom(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const raw = set.find((c) => c.startsWith("ih_admin="));
  return raw ? raw.split(";")[0] : "";
}

{
  const r = await api(port, `${base}/auth/devtoken`, { method: "POST", body: { token: "wrong" } });
  ok("devtoken with wrong token -> 401", r.status === 401);
}
{
  const r = await api(port, `${base}/auth/devtoken`, { method: "POST", body: { token: ADMIN_TOKEN } });
  ok("devtoken sign-in -> 200 + session cookie", r.status === 200 && cookieFrom(r).startsWith("ih_admin="));
  sessionCookie = cookieFrom(r);
}
{
  const r = await fetch(`http://127.0.0.1:${port}${base}/auth/me`, { headers: { Cookie: sessionCookie } });
  const j = await r.json();
  ok("auth/me with session cookie", r.status === 200 && j.authenticated === true && j.session.auth === "devtoken");
}
{
  const r = await fetch(`http://127.0.0.1:${port}${base}/auth/me`);
  const j = await r.json();
  ok("auth/me reports hasAdmins=false on empty store", j.hasAdmins === false);
}
{
  const r = await api(port, `${base}/admin/tokens`, { token: "wrong" });
  ok("admin tokens with wrong header still 401", r.status === 401);
  const r2 = await fetch(`http://127.0.0.1:${port}${base}/admin/tokens`, { headers: { Cookie: sessionCookie } });
  ok("admin tokens via session cookie -> 200", r2.status === 200);
}

// ---- passkey endpoints -------------------------------------------------------
{
  const r = await api(port, `${base}/auth/passkey/register/options`, { method: "POST", body: { email: "a@b.c" } });
  ok("passkey register options without session -> 401", r.status === 401);
}
{
  const r = await fetch(`http://127.0.0.1:${port}${base}/auth/passkey/register/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    body: JSON.stringify({ email: "dev-token" }),
  });
  ok("passkey register options for non-allowlisted account -> 403", r.status === 403);
}
{
  const r = await api(port, `${base}/auth/passkey/login/options`, { method: "POST", body: {} });
  ok("passkey login options (empty registry) -> 200", r.status === 200);
}
{
  const r = await api(port, `${base}/auth/passkey/login/verify`, {
    method: "POST",
    body: { challengeId: "nope", response: { id: "x", rawId: "eA", type: "public-key", response: {} } },
  });
  ok("passkey login verify with bad challenge -> 401", r.status === 401);
}
{
  const r = await api(port, `${base}/auth/google`, { method: "POST", body: { idToken: "not-a-real-token" } });
  ok("google login with invalid ID token -> 401", r.status === 401);
}

// ---- admin allowlist + audit via session --------------------------------------
{
  const r = await fetch(`http://127.0.0.1:${port}${base}/auth/admins`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: sessionCookie }, body: JSON.stringify({ email: "teammate@example.com" }) });
  ok("add admin via session -> 200", r.status === 200);
}
{
  const r = await fetch(`http://127.0.0.1:${port}${base}/auth/admins`, { headers: { Cookie: sessionCookie } });
  const j = await r.json();
  ok("admin allowlist lists teammate", r.status === 200 && j.admins.some((a) => a.email === "teammate@example.com"));
}
{
  const r = await fetch(`http://127.0.0.1:${port}${base}/auth/me`);
  const j = await r.json();
  ok("auth/me reports hasAdmins=true after adding admin", j.hasAdmins === true);
}
{
  const r = await fetch(`http://127.0.0.1:${port}${base}/auth/audit`, { headers: { Cookie: sessionCookie } });
  const j = await r.json();
  ok("audit log records dev-token + admin actions", r.status === 200 && j.audit.some((a) => a.method === "admins.add") && j.audit.some((a) => a.method === "auth.devtoken"));
}
{
  const r = await fetch(`http://127.0.0.1:${port}${base}/auth/admins/teammate@example.com`, { method: "DELETE", headers: { Cookie: sessionCookie } });
  ok("remove admin via session -> 200", r.status === 200);
}
{
  const r = await api(port, `${base}/auth/credentials`, { token: ADMIN_TOKEN });
  ok("credentials list via legacy header -> 200", r.status === 200);
}

server.child.kill("SIGTERM");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
