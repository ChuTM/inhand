/**
 * client/helper/test-daemon.mjs — Mock-mode test of the firewall daemon.
 *
 * Runs daemon.mjs with INHAND_FW_MOCK=1 (no root, no pfctl) in a temp dir and
 * exercises the socket protocol end to end, signing events with the REAL host
 * crypto (host/lib/crypto.mjs) exactly like the teacher would:
 *
 *   - ping / status
 *   - setkey first-set wins, second setkey rejected
 *   - forward lock (valid signature) -> locked
 *   - forward unlock (valid signature) -> unlocked
 *   - forward with bad signature -> rejected
 *   - forward with replayed nonce -> rejected
 *   - forward with stale timestamp -> rejected
 *
 * Run: node test-daemon.mjs
 */
import { spawn } from "child_process";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const { generateKeyPair, signPayload, canonicalize } = await import(
	path.join(repoRoot, "host/lib/crypto.mjs")
);

let passed = 0;
let failed = 0;
function ok(name, cond) {
	cond ? passed++ : failed++;
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inhand-fw-test-"));
const fwDir = path.join(tmp, "fw");
const sock = path.join(fwDir, "inhand-fw.sock");

const child = spawn(process.execPath, [path.join(__dirname, "daemon.mjs")], {
	env: {
		...process.env,
		INHAND_FW_MOCK: "1",
		INHAND_FW_DIR: fwDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let daemonOut = "";
child.stdout.on("data", (d) => (daemonOut += d));
child.stderr.on("data", (d) => (daemonOut += d));

function request(obj, timeoutMs = 4000) {
	return new Promise((resolve, reject) => {
		const s = net.connect(sock);
		let out = "";
		const t = setTimeout(() => {
			s.destroy();
			reject(new Error("timeout"));
		}, timeoutMs);
		s.setEncoding("utf8");
		s.on("connect", () => s.write(JSON.stringify(obj) + "\n"));
		s.on("data", (c) => {
			out += c;
			const i = out.indexOf("\n");
			if (i === -1) return;
			clearTimeout(t);
			s.destroy();
			try {
				resolve(JSON.parse(out.slice(0, i)));
			} catch (e) {
				reject(e);
			}
		});
		s.on("error", reject);
	});
}

// Teacher signs an admin-command envelope exactly like host/main.js does.
function signedCommand(keys, cmd, { ts = Date.now(), nonce } = {}) {
	const env = {
		t: "admin-command",
		p: { cmd },
		ts,
		n: nonce || Math.random().toString(16).slice(2),
	};
	env.s = signPayload(keys.signPriv, canonicalize(env.t, env.p, env.ts, env.n));
	return env;
}

await new Promise((resolve) => {
	const t = setInterval(() => {
		if (daemonOut.includes("listening")) {
			clearInterval(t);
			resolve();
		}
	}, 30);
	setTimeout(() => {
		clearInterval(t);
		resolve();
	}, 5000);
});

console.log("\nFirewall daemon mock test\n");

const teacher = generateKeyPair();
const lanOnly = (on, ttl) => ({ type: "lan-only", params: { on, ...(ttl ? { ttl } : {}) } });

// ---- ping / status ----------------------------------------------------------
{
	const p = await request({ op: "ping" });
	ok("ping", p.ok === true && p.service === "inhand-fw");
}
{
	const s = await request({ op: "status" });
	ok("status initial (unlocked, no key)", s.ok && s.locked === false && s.keySet === false);
}

// ---- setkey -----------------------------------------------------------------
{
	const r = await request({ op: "setkey", signPub: teacher.signPub });
	ok("setkey first-set wins", r.ok === true && r.keySet === true);
}
{
	const r = await request({ op: "setkey", signPub: teacher.signPub });
	ok("setkey second set rejected", r.ok === false && /already-set/.test(r.error));
}

// ---- lock / unlock with valid teacher signature ------------------------------
{
	const env = signedCommand(teacher, lanOnly(true, 60));
	const r = await request({ op: "forward", evt: env });
	ok("forward lock (valid sig)", r.ok === true && r.locked === true && r.ttlMinutes === 60 && r.deadline > Date.now());
}
{
	const s = await request({ op: "status" });
	ok("status locked", s.ok && s.locked === true && s.deadline !== null);
}
{
	const env = signedCommand(teacher, lanOnly(false));
	const r = await request({ op: "forward", evt: env });
	ok("forward unlock (valid sig)", r.ok === true && r.locked === false);
}
{
	const s = await request({ op: "status" });
	ok("status unlocked after release", s.ok && s.locked === false);
}

// ---- rejection paths ---------------------------------------------------------
{
	const env = signedCommand(teacher, lanOnly(true, 60));
	env.s = "AAAA" + env.s.slice(4); // tamper
	const r = await request({ op: "forward", evt: env });
	ok("tampered signature rejected", r.ok === false && /signature-invalid/.test(r.error));
}
{
	const env = signedCommand(teacher, lanOnly(true, 60));
	await request({ op: "forward", evt: env }); // consume nonce
	const r = await request({ op: "forward", evt: env }); // replay same nonce
	ok("replayed nonce rejected", r.ok === false && /signature-invalid/.test(r.error));
}
{
	const env = signedCommand(teacher, lanOnly(true, 60), { ts: Date.now() - 300_000 });
	const r = await request({ op: "forward", evt: env });
	ok("stale timestamp rejected", r.ok === false);
}
{
	const env = signedCommand(teacher, { type: "wallpaper", params: { path: "/x" } });
	const r = await request({ op: "forward", evt: env });
	ok("non-lan-only command rejected", r.ok === false && /expected lan-only/.test(r.error));
}
{
	const env = signedCommand(teacher, lanOnly(true, 60));
	const r = await request({ op: "forward", evt: { ...env, t: "teacher-start-share" } });
	ok("wrong event type rejected", r.ok === false);
}
{
	const r = await request({ op: "forward", evt: signedCommand(teacher, lanOnly(true, 60)) });
	const s = await request({ op: "status" });
	ok("machine left locked after rejections", s.ok && s.locked === true);
	await request({ op: "forward", evt: signedCommand(teacher, lanOnly(false)) });
}

// ---- ttl bounds --------------------------------------------------------------
{
	const r = await request({ op: "forward", evt: signedCommand(teacher, lanOnly(true, 99999)) });
	ok("ttl clamped to 1440", r.ok && r.ttlMinutes === 1440);
	await request({ op: "forward", evt: signedCommand(teacher, lanOnly(false)) });
}

child.kill("SIGTERM");
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
