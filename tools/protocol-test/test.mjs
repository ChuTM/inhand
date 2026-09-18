/**
 * tools/protocol-test/test.mjs — End-to-end security protocol test.
 *
 * Runs a mock cloud (discovery API), a mock teacher host (socket.io signaling
 * + host crypto), and a simulated student client (client crypto). Verifies:
 *   1. Cloud-signed discovery payload -> client verifies with cloud pub.
 *   2. Teacher keys wrap/unwrap with scrypt-derived password.
 *   3. Student registers with an ECIES-encrypted name; host decrypts it.
 *   4. Host signs a whitelisted command; client verifies it and executes.
 *   5. Client sends an ECIES-encrypted result; host decrypts it.
 *
 * Run: node tools/protocol-test/test.mjs
 */
import http from "http";
import crypto from "crypto";
import { createRequire } from "module";
import {
	generateKeyPair,
	wrapPrivateKeys,
	unwrapPrivateKeys,
	signPayload,
	verifyPayload,
	canonicalize,
	encryptTo,
	decryptFrom,
} from "../../host/lib/crypto.mjs";

const require = createRequire(import.meta.url);
const clientCrypto = require("../../client/lib/crypto.js");
const { io: clientIo } = require("../../client/node_modules/socket.io-client");
const { Server } = require("../../host/node_modules/socket.io");

let passed = 0;
let failed = 0;
function assert(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  PASS  ${name}`);
	} else {
		failed++;
		console.log(`  FAIL  ${name} ${extra}`);
	}
}

// --- 1. Crypto roundtrips (host lib <-> client lib interop) ---
console.log("\n[1] Crypto interop (host lib <-> client lib)");
{
	const teacher = generateKeyPair();

	// host signs, client verifies
	const msg = canonicalize("admin-command", { cmd: { type: "wallpaper" } }, 123, "abc");
	const sig = signPayload(teacher.signPriv, msg);
	assert("client verifies host Ed25519 signature", clientCrypto.verifyPayload(teacher.signPub, msg, sig));
	assert("client rejects tampered message", !clientCrypto.verifyPayload(teacher.signPub, msg + "x", sig));

	// client encrypts to host, host decrypts
	const envelope = clientCrypto.encryptTo(teacher.encPub, { name: "stu-01", secret: "s3cr3t" });
	const decrypted = JSON.parse(decryptFrom(teacher.encPriv, envelope));
	assert("host decrypts client ECIES envelope", decrypted.name === "stu-01" && decrypted.secret === "s3cr3t");

	// host encrypts, client cannot decrypt (no private key on client) — just sanity
	const env2 = encryptTo(teacher.encPub, JSON.stringify({ hello: "world" }));
	assert("host envelope shape ok", typeof env2.ct === "string" && env2.v === 1);

	// tampered ciphertext must fail
	const bad = { ...envelope, ct: Buffer.from("00".repeat(envelope.ct.length), "hex").toString("base64") };
	let threw = false;
	try {
		JSON.parse(decryptFrom(teacher.encPriv, bad));
	} catch {
		threw = true;
	}
	assert("tampered ciphertext rejected", threw);
}

// --- 2. Keystore wrap/unwrap (host side) ---
console.log("\n[2] Password-wrapped keyring");
{
	const keys = generateKeyPair();
	const blob = wrapPrivateKeys(keys, "correct-horse-123");
	const priv = unwrapPrivateKeys(blob, "correct-horse-123");
	assert("unwrap with correct password", priv.signPriv === keys.signPriv && priv.encPriv === keys.encPriv);
	let threw = false;
	try {
		unwrapPrivateKeys(blob, "wrong-password");
	} catch {
		threw = true;
	}
	assert("wrong password rejected", threw);
}

// --- 3..5. Full protocol flow ---
console.log("\n[3-5] Cloud discovery + signed command + encrypted result");

const cloud = generateKeyPair(); // the OFFICIALLY HOSTED cloud
const teacher = generateKeyPair(); // the teacher

// Mock cloud: POST /api/v1/admin/register, GET /api/v1/discover, GET /api/v1/update
const registration = { token: "school-token-1", lanIp: "192.168.1.10", expiresAt: new Date(Date.now() + 3600_000).toISOString() };
let cloudServer;
await new Promise((resolve) => {
	cloudServer = http.createServer((req, res) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			return res.end();
		}
		if (req.method === "POST" && req.url === "/api/v1/admin/register") {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				const b = JSON.parse(body);
				if (b.token !== registration.token) {
					res.writeHead(401);
					return res.end(JSON.stringify({ ok: false, error: "bad token" }));
				}
				registration.lanIp = b.lanIp;
				registration.signPub = b.signPub;
				registration.encPub = b.encPub;
				res.writeHead(200);
				res.end(JSON.stringify({ ok: true, registrationId: "reg-1", heartbeatMs: 60000, expiresInMs: 3600000 }));
			});
			return;
		}
		if (req.method === "GET" && req.url === "/api/v1/discover") {
			const payload = Buffer.from(
				JSON.stringify({
					lanIp: registration.lanIp,
					signPub: teacher.signPub,
					encPub: teacher.encPub,
					schoolName: "Test School",
					ts: Date.now(),
					expiresAt: registration.expiresAt,
				}),
			).toString("base64");
			const signature = signPayload(cloud.signPriv, payload);
			res.writeHead(200);
			res.end(JSON.stringify({ payload, signature }));
			return;
		}
		if (req.method === "GET" && req.url === "/api/v1/update") {
			const manifest = JSON.stringify({ version: "9.9.9", url: "https://example.com/x.zip", sha256: "ab".repeat(32) });
			const signature = signPayload(cloud.signPriv, manifest);
			res.writeHead(200);
			res.end(JSON.stringify({ version: "9.9.9", url: "https://example.com/x.zip", sha256: "ab".repeat(32), signature }));
			return;
		}
		res.writeHead(404);
		res.end("not found");
	});
	cloudServer.listen(0, "127.0.0.1", resolve);
});
const cloudPort = cloudServer.address().port;
const cloudUrl = `http://127.0.0.1:${cloudPort}`;

// Mock host: socket.io signaling server using host crypto
let receivedName = null;
let receivedResult = null;
const hostHttp = http.createServer();
const ioServer = new Server({ cors: { origin: "*" } });
ioServer.attach(hostHttp);
await new Promise((resolve) => hostHttp.listen(0, "127.0.0.1", resolve));
const hostPort = hostHttp.address().port;

// Mock host must also accept /command-result (the real host does)
hostHttp.on("request", (req, res) => {
	if (req.method === "POST" && req.url === "/command-result") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			try {
				const data = JSON.parse(decryptFrom(teacher.encPriv, JSON.parse(body).enc));
				receivedResult = data;
				res.writeHead(200);
				res.end(JSON.stringify(true));
			} catch (e) {
				res.writeHead(400);
				res.end(JSON.stringify({ error: e.message }));
			}
		});
	}
});

ioServer.on("connection", (socket) => {
	socket.on("register-mac", (payload) => {
		try {
			const data = JSON.parse(decryptFrom(teacher.encPriv, payload.enc));
			receivedName = data.name;
			// Host signs a whitelisted command and sends it down.
			const ts = Date.now();
			const n = crypto.randomBytes(8).toString("hex");
			const cmdPayload = { cmd: { type: "configMode", params: { on: true } } };
			const sig = signPayload(teacher.signPriv, canonicalize("admin-command", cmdPayload, ts, n));
			socket.emit("admin-command", { t: "admin-command", p: cmdPayload, ts, n, s: sig });
		} catch (e) {
			console.error("Mock host failed to decrypt register:", e.message);
		}
	});
});

// Simulated client (mirrors client/main.js logic, no Electron)
const teacherPub = { signPub: teacher.signPub, encPub: teacher.encPub };
const nonceGuard = clientCrypto.createNonceGuard(120000);

// (a) discovery
const discRes = await fetch(`${cloudUrl}/api/v1/discover`);
const disc = await discRes.json();
const cloudOk = clientCrypto.verifyPayload(cloud.signPub, disc.payload, disc.signature);
assert("client verifies cloud discovery signature", cloudOk);
const discovered = JSON.parse(Buffer.from(disc.payload, "base64").toString("utf8"));
assert("discovery contains teacher pubs", discovered.signPub === teacher.signPub && discovered.encPub === teacher.encPub);

// (b) connect + encrypted registration
const clientSocket = clientIo(`http://127.0.0.1:${hostPort}`, { transports: ["websocket"] });
await new Promise((resolve, reject) => {
	clientSocket.on("connect", resolve);
	clientSocket.on("connect_error", reject);
	setTimeout(() => reject(new Error("connect timeout")), 5000);
});

function isVerifiedTeacherEvent(type, env) {
	if (!nonceGuard.check(env)) return false;
	return clientCrypto.verifyPayload(
		teacherPub.signPub,
		clientCrypto.canonicalize(type, env.p, env.ts, env.n),
		env.s,
	);
}

clientSocket.emit("register-mac", {
	enc: clientCrypto.encryptTo(teacherPub.encPub, { name: "stu-42" }),
});

// (c) receive + verify + execute whitelisted command, reply encrypted
const cmdReceived = new Promise((resolve) => {
	clientSocket.on("admin-command", (env) => {
		if (!isVerifiedTeacherEvent("admin-command", env)) {
			resolve({ ok: false, reason: "signature rejected" });
			return;
		}
		const cmd = env.p.cmd;
		if (cmd.type !== "configMode" || cmd.params.on !== true) {
			resolve({ ok: false, reason: "wrong command" });
			return;
		}
		// "execute": configMode is pure logic (no Electron)
		const executed = true;
		// encrypted result back
		const envelope = clientCrypto.encryptTo(teacherPub.encPub, {
			user: "stu-42",
			command: "configMode",
			result: { stdout: "config mode enabled", stderr: "" },
		});
		fetch(`http://127.0.0.1:${hostPort}/command-result`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enc: envelope }),
		})
			.then((r) => r.json())
			.then(() => resolve({ ok: executed, reason: "" }));
	});
});

const cmdResult = await Promise.race([
	cmdReceived,
	new Promise((_, rej) => setTimeout(() => rej(new Error("command timeout")), 8000)),
]);
assert("client verified + executed signed whitelisted command", cmdResult.ok, cmdResult.reason);

// wait for the result round trip
await new Promise((r) => setTimeout(r, 300));
assert("host decrypted client ECIES command result", receivedResult?.user === "stu-42" && receivedResult?.result?.stdout === "config mode enabled", JSON.stringify(receivedResult));
assert("host decrypted registration name", receivedName === "stu-42", String(receivedName));

// (d) update manifest signature (client-side poll logic)
const updRes = await fetch(`${cloudUrl}/api/v1/update`);
const upd = await updRes.json();
const manifest = JSON.stringify({ version: upd.version, url: upd.url, sha256: upd.sha256 });
assert("client verifies cloud update manifest signature", clientCrypto.verifyPayload(cloud.signPub, manifest, upd.signature));

// (e) anti-replay: same envelope twice must be rejected
const envReplay = clientCrypto.encryptTo(teacherPub.encPub, { name: "replay" });
const ts2 = Date.now();
const n2 = "nonce-replay-test";
const sig2 = signPayload(teacher.signPriv, canonicalize("admin-command", { cmd: { type: "restart", params: {} } }, ts2, n2));
const replayEnv = { t: "admin-command", p: { cmd: { type: "restart", params: {} } }, ts: ts2, n: n2, s: sig2 };
assert("nonce accepted once", isVerifiedTeacherEvent("admin-command", replayEnv));
assert("nonce replay rejected", !isVerifiedTeacherEvent("admin-command", replayEnv));

clientSocket.close();
ioServer.close();
cloudServer.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
