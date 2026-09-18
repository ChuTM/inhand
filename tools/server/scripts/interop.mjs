/**
 * tools/server/interop.mjs — Client-interop check.
 *
 * Boots the real server (sqlite) and drives it with the ACTUAL repo crypto
 * code paths: host/lib/crypto.mjs for the teacher side, client/lib/crypto.js
 * for the student side. Verifies the server's discover + update signatures
 * are exactly what the real clients expect.
 *
 * Run: node interop.mjs
 */
import { spawn } from "child_process";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);

const { generateKeyPair: hostKeyPair } = await import(
	path.join(repoRoot, "host/lib/crypto.mjs")
);
const clientCrypto = require(path.join(repoRoot, "client/lib/crypto.js"));

const ADMIN_TOKEN = "interop-admin";
let passed = 0, failed = 0;
const ok = (name, cond) => {
	cond ? passed++ : failed++;
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
};

function freePort() {
	return new Promise((resolve, reject) => {
		const s = net.createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = s.address().port;
			s.close(() => resolve(p));
		});
		s.on("error", reject);
	});
}

const port = await freePort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wg-interop-"));
const child = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
	cwd: __dirname,
	env: {
		...process.env,
		HOST: "127.0.0.1",
		PORT: String(port),
		STORAGE_DRIVER: "sqlite",
		DB_FILE: path.join(tmp, "server.db"),
		KEYS_FILE: path.join(tmp, "cloud-keys.json"),
		ADMIN_TOKEN,
		VERBOSE: "false",
		PUBLIC_IP_MODE: "socket",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
await new Promise((resolve) => {
	const t = setInterval(() => {
		if (out.includes("Listening on")) { clearInterval(t); resolve(); }
	}, 30);
	setTimeout(() => { clearInterval(t); resolve(); }, 5000);
});

const base = "/api/v1";
const A = (p, o = {}) =>
	fetch(`http://127.0.0.1:${port}${p}`, {
		...o,
		headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN, ...(o.headers || {}) },
	});

// cloud public key the server actually uses
const stats = await (await A(`${base}/admin/stats`)).json();
const cloudPub = stats.config.cloudPub;

console.log(`\nClient interop (port ${port}, sqlite, cloud pub ${cloudPub.slice(0, 16)}…)\n`);

// ---- teacher side: register with the HOST's real keypair --------------------
const hostKeys = hostKeyPair();
const regToken = (await (await A(`${base}/admin/tokens`, { method: "POST", body: JSON.stringify({ label: "school" }) })).json()).token;
const regRes = await A(`${base}/admin/register`, {
	method: "POST",
	body: JSON.stringify({
		token: regToken,
		lanIp: "192.168.50.10",
		signPub: hostKeys.signPub,
		encPub: hostKeys.encPub,
		info: { schoolName: "School of Physics" },
	}),
});
if (regRes.status !== 200) {
	console.log(`    [debug] register -> ${regRes.status} ${await regRes.text()}`);
}
ok("teacher registers with real host keypair", regRes.status === 200);

// ---- student side: discover + verify with the REAL client crypto ------------
const disc = await (await fetch(`http://127.0.0.1:${port}${base}/discover`)).json();
const payload = JSON.parse(Buffer.from(disc.payload, "base64").toString("utf8"));
ok("client-verify: discover signature OK (client/lib/crypto.js)", clientCrypto.verifyPayload(cloudPub, disc.payload, disc.signature));
ok("client-verify: lanIp is private", /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d)\.)/.test(payload.lanIp));
ok("client-verify: teacher key present", payload.signPub === hostKeys.signPub && payload.encPub === hostKeys.encPub);
ok("client-verify: expiresAt in future", payload.expiresAt > Date.now());

// ---- update manifest: publish + verify with the REAL client crypto ----------
await A(`${base}/admin/updates`, {
	method: "POST",
	body: JSON.stringify({ version: "3.0.0", url: "https://example.com/WG.dmg", sha256: "b".repeat(64) }),
});
const upd = await (await fetch(`http://127.0.0.1:${port}${base}/update`)).json();
ok(
	"client-verify: update signature OK over {version,url,sha256}",
	clientCrypto.verifyPayload(
		cloudPub,
		JSON.stringify({ version: upd.version, url: upd.url, sha256: upd.sha256 }),
		upd.signature,
	),
);

child.kill("SIGTERM");
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
