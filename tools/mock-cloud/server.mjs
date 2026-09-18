/**
 * tools/mock-cloud/server.mjs — Local mock of the officially hosted cloud API.
 *
 * Implements the agreed API contract so you can develop/run the Host and
 * Client without a real server:
 *
 *   POST /api/v1/admin/register   { token, lanIp, signPub, encPub, info }
 *        -> 200 { ok, registrationId, heartbeatMs, expiresInMs }
 *        -> 401 invalid token | 409 public IP already registered
 *   GET  /api/v1/discover         -> 200 { payload(base64), signature(base64) }
 *        -> 204 no active registration for this public IP
 *   POST /api/v1/admin/unregister { token }
 *   GET  /api/v1/update           -> { version, url, sha256, signature }
 *
 * "Public IP" is simulated as the TCP peer address of the request (in real
 * deployment the server would read the real public IP, e.g. from
 * x-forwarded-for / the socket address).
 *
 * Run: node tools/mock-cloud/server.mjs [port] [token] [schoolName]
 * Env:  MOCK_CLOUD_UPDATE_URL / MOCK_CLOUD_UPDATE_SHA256 / MOCK_CLOUD_UPDATE_VERSION
 */
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { generateKeyPair, signPayload } from "../../host/lib/crypto.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = path.join(__dirname, "cloud-keys.json");

function loadCloudKeys() {
	if (fs.existsSync(KEYS_FILE)) {
		return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
	}
	const keys = generateKeyPair();
	fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
	console.log("[mock-cloud] Generated cloud keypair ->", KEYS_FILE);
	return keys;
}

const cloudKeys = loadCloudKeys();
const TOKEN = process.argv[3] || "school-token-1";
const SCHOOL_NAME = process.argv[4] || "Mock School";
const PORT = Number(process.argv[2]) || 8787;

// One active registration per public IP (a real deployment would store these
// server-side with heartbeat-based expiry).
const registrations = new Map(); // publicIp -> registration

function publicIpOf(req) {
	const fwd = req.headers["x-forwarded-for"];
	if (fwd) return fwd.split(",")[0].trim();
	return req.socket.remoteAddress || "unknown";
}

function readBody(req) {
	return new Promise((resolve) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			try {
				resolve(JSON.parse(body));
			} catch {
				resolve({});
			}
		});
	});
}

const server = http.createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (req.method === "OPTIONS") {
		res.writeHead(204);
		return res.end();
	}

	const ip = publicIpOf(req);
	console.log(`[mock-cloud] ${req.method} ${req.url} (public IP: ${ip})`);

	if (req.method === "POST" && req.url === "/api/v1/admin/register") {
		const body = await readBody(req);
		if (body.token !== TOKEN) {
			res.writeHead(401);
			return res.end(JSON.stringify({ ok: false, error: "invalid token" }));
		}
		if (registrations.has(ip) && registrations.get(ip).lanIp !== body.lanIp) {
			res.writeHead(409);
			return res.end(
				JSON.stringify({ ok: false, error: "public IP already registered" }),
			);
		}
		registrations.set(ip, {
			lanIp: body.lanIp,
			signPub: body.signPub,
			encPub: body.encPub,
			schoolName: body.info?.schoolName || SCHOOL_NAME,
			ts: Date.now(),
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
		});
		console.log("[mock-cloud] Registered:", JSON.stringify(registrations.get(ip), null, 2));
		res.writeHead(200);
		return res.end(
			JSON.stringify({
				ok: true,
				registrationId: "mock-" + crypto.randomBytes(4).toString("hex"),
				heartbeatMs: 60000,
				expiresInMs: 3600000,
			}),
		);
	}

	if (req.method === "POST" && req.url === "/api/v1/admin/unregister") {
		const body = await readBody(req);
		if (body.token !== TOKEN) {
			res.writeHead(401);
			return res.end(JSON.stringify({ ok: false, error: "invalid token" }));
		}
		registrations.delete(ip);
		return res.end(JSON.stringify({ ok: true }));
	}

	if (req.method === "GET" && req.url === "/api/v1/discover") {
		const reg = registrations.get(ip);
		if (!reg) {
			res.writeHead(204);
			return res.end();
		}
		const payload = Buffer.from(
			JSON.stringify({
				lanIp: reg.lanIp,
				signPub: reg.signPub,
				encPub: reg.encPub,
				schoolName: reg.schoolName,
				ts: reg.ts,
				expiresAt: reg.expiresAt,
			}),
		).toString("base64");
		const signature = signPayload(cloudKeys.signPriv, payload);
		res.writeHead(200);
		return res.end(JSON.stringify({ payload, signature }));
	}

	if (req.method === "GET" && req.url === "/api/v1/update") {
		const manifest = {
			version: process.env.MOCK_CLOUD_UPDATE_VERSION || "1.3.0",
			url:
				process.env.MOCK_CLOUD_UPDATE_URL ||
				"https://example.com/InHand-arm64.dmg",
			sha256:
				process.env.MOCK_CLOUD_UPDATE_SHA256 || "ab".repeat(32),
		};
		const signature = signPayload(
			cloudKeys.signPriv,
			JSON.stringify(manifest),
		);
		res.writeHead(200);
		return res.end(JSON.stringify({ ...manifest, signature }));
	}

	res.writeHead(404);
	res.end(JSON.stringify({ ok: false, error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`[mock-cloud] Listening on http://127.0.0.1:${PORT}`);
	console.log(`[mock-cloud] Token: ${TOKEN}`);
	console.log(`[mock-cloud] Cloud public key (put in client/config.json "cloudPub"):`);
	console.log(cloudKeys.signPub);
});
