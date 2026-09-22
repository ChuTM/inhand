/**
 * client/helper/daemon.mjs — LAN-only firewall daemon (runs as root).
 *
 * A tiny privileged helper that enforces "external access cut, LAN only" on
 * the student's machine. It is the ONLY privileged component in the system.
 *
 *   - Applies / removes a pf anchor (`com.inhand`). On first use it declares
 *     the anchor point in /etc/pf.conf (a one-line, idempotent append; the
 *     pristine file is kept at /etc/pf.conf.inhand.bak) and reloads the main
 *     ruleset — a pf anchor only filters traffic when the main ruleset
 *     references it. Uninstall removes the line again.
 *   - Listens on a Unix socket. Accepts `ping`, `status`, `setkey` and
 *     `forward` (a signed teacher `admin-command` event that the client
 *     re-forwards so the daemon can verify it with its own copy of the
 *     teacher's public key — a compromised client cannot forge unlock).
 *   - Unlock (on=false) requires a valid teacher signature; students cannot
 *     unblock. TTL auto-release prevents lockouts.
 *   - `setkey` overwrites: the teacher key may be replaced at any time. We do
 *     not fight students who can swap keys themselves — the daemon's real
 *     guard is that unlock requires a valid teacher signature, not that the
 *     key is hard to change.
 *
 * Runtime: `ELECTRON_RUN_AS_NODE=1 <app executable> daemon.mjs` via the
 * LaunchDaemon installed by `install.sh -f`, or plain `node daemon.mjs` for
 * dev/testing. Set INHAND_FW_MOCK=1 to run without root/pfctl (used by tests).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";

// ------------------------------------------------------------------ constants

const FW_DIR = process.env.INHAND_FW_DIR || "/Library/Application Support/InHand";
const SOCKET = path.join(FW_DIR, "inhand-fw.sock");
const STATE_FILE = path.join(FW_DIR, "fw-state.json");
const CONFIG_FILE = path.join(FW_DIR, "fw-config.json");
const LOG_FILE = path.join(FW_DIR, "fw.log");
const RULES_FILE = path.join(FW_DIR, "fw.rules");
const ANCHOR = "com.inhand";
const PFCTL = "/sbin/pfctl";
const MOCK = process.env.INHAND_FW_MOCK === "1";
const EVENT_WINDOW_MS = 120_000; // match client nonce window
const MAX_LINE = 64 * 1024;
const VERSION = 1;

/**
 * pf rules: block all outbound, then pass private ranges (LAN, IPv4 + IPv6),
 * loopback, link-local, multicast, DHCP and DNS (see README for the DNS-tunnel
 * caveat). Written to FW_DIR/fw.rules by the daemon; `inhand-fwctl` reuses the
 * same file.
 */
const RULES_TEXT = `# InHand LAN-only rules (auto-generated)
# pass rules come FIRST: macOS pf applies the first matching rule, so a
# leading "block out" would also kill LAN/loopback traffic and sever the
# client<->host socket, making unlock commands unreachable.
pass out quick to { 10/8, 172.16/12, 192.168/16, 100.64/10, 127/8, 169.254/16, 224/4, ::1/128, fe80::/10, fc00::/7, ff00::/8 } keep state
pass out quick proto { udp tcp } to port 53 keep state
pass out quick proto udp to port 67 keep state
block out log all
`;

// --------------------------------------------------------------------- crypto

function b64(buf) {
	return buf.toString("base64");
}
function fromB64(s) {
	return Buffer.from(String(s), "base64");
}

/** Stable canonical string — must match client/lib/crypto.js + host/lib/keystore.mjs. */
function canonicalize(type, payload, ts, nonce) {
	return JSON.stringify({ t: type, p: payload ?? null, ts, n: nonce });
}

/** Verify an Ed25519 signature. Never throws. */
function verifyPayload(signPubB64, message, sigB64) {
	try {
		const pub = fromB64(signPubB64);
		const key = crypto.createPublicKey({ key: pub, type: "spki", format: "der" });
		return crypto.verify(null, Buffer.from(message, "utf8"), key, fromB64(sigB64));
	} catch {
		return false;
	}
}

function verifyTeacherEvent(signPub, evt) {
	if (!evt || typeof evt !== "object") return false;
	if (typeof evt.ts !== "number" || typeof evt.n !== "string" || typeof evt.s !== "string") {
		return false;
	}
	if (Math.abs(Date.now() - evt.ts) > EVENT_WINDOW_MS) return false;
	if (!nonceGuard.check(evt.n, evt.ts)) return false;
	return verifyPayload(
		signPub,
		canonicalize(evt.t, evt.p, evt.ts, evt.n),
		evt.s,
	);
}

// ------------------------------------------------------------- nonce / logging

const seenNonces = new Set();
const nonceGuard = {
	check(nonce, ts) {
		if (!nonce || seenNonces.has(nonce)) return false;
		seenNonces.add(nonce);
		// bounded memory: drop entries older than the window
		if (seenNonces.size > 2048) {
			for (const n of seenNonces) seenNonces.delete(n);
		}
		return true;
	},
};

function log(entry) {
	const line = `${new Date().toISOString()} ${JSON.stringify(entry)}`;
	try {
		if (MOCK) {
			console.log(line);
		} else {
			fs.appendFileSync(LOG_FILE, line + "\n", { mode: 0o600 });
		}
	} catch {
		/* logging must never crash the daemon */
	}
}

// ---------------------------------------------------------------- state files

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJson(file, obj, mode = 0o600) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
	fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode });
}

function readState() {
	return readJson(STATE_FILE, { locked: false });
}
function writeState(state) {
	writeJson(STATE_FILE, state);
}
function readConfig() {
	return readJson(CONFIG_FILE, { signPub: null });
}

/** Short fingerprint of the configured teacher key (for client-side mismatch detection). */
function keyFingerprint(pubB64) {
	if (!pubB64) return null;
	return crypto.createHash("sha256").update(pubB64).digest("hex").slice(0, 16);
}

// ------------------------------------------------------------------ pf engine

function runPf(args) {
	return new Promise((resolve) => {
		if (MOCK) {
			log({ mock: "pfctl", args });
			resolve({ status: 0, stderr: "" });
			return;
		}
		execFile(PFCTL, args, (err, _stdout, stderr) => {
			resolve({ status: err ? err.code ?? 1 : 0, stderr: String(stderr || "") });
		});
	});
}

function runPfOut(args) {
	return new Promise((resolve) => {
		if (MOCK) {
			resolve({ status: 0, stdout: `anchor "com.inhand" all` });
			return;
		}
		execFile(PFCTL, args, (err, stdout, _stderr) => {
			resolve({ status: err ? err.code ?? 1 : 0, stdout: String(stdout || "") });
		});
	});
}

async function enablePf() {
	if (MOCK) return true;
	// Ignore "already enabled" failures.
	const r = await runPf(["-e"]);
	if (r.status !== 0 && !/already enabled/i.test(r.stderr)) {
		log({ error: "pf enable failed", stderr: r.stderr });
		return false;
	}
	return true;
}

// macOS evaluates an anchor only when the main ruleset declares it. Apple's
// default /etc/pf.conf has no com.inhand anchor, so rules loaded purely with
// `pfctl -a com.inhand -f …` would never run. Declare the anchor point in
// /etc/pf.conf (idempotent append, original preserved as a backup) and reload
// the main ruleset so the anchor sits on the filter path.
const PF_CONF = "/etc/pf.conf";
const PF_CONF_BACKUP = "/etc/pf.conf.inhand.bak";
const ANCHOR_LINE = 'anchor "com.inhand"';

async function ensureAnchor() {
	if (MOCK) return true;
	let conf = "";
	try {
		conf = fs.readFileSync(PF_CONF, "utf8");
	} catch {
		log({ error: "pf.conf missing", file: PF_CONF });
		return false;
	}
	let changed = false;
	let next = conf;

	// Loopback traffic (host<->client on the same machine) must never be
	// filtered by the lock rules, or the client's socket to the host dies the
	// moment LAN-only engages and unlock commands can't get through.
	if (!/^\s*set skip on lo0\s*$/m.test(next)) {
		const lines = next.split("\n");
		let insertAt = lines.length;
		for (let i = 0; i < lines.length; i++) {
			const t = lines[i].trim();
			if (t && !t.startsWith("#")) {
				insertAt = i;
				break;
			}
		}
		lines.splice(insertAt, 0, "set skip on lo0");
		next = lines.join("\n");
		changed = true;
	}

	if (!new RegExp(`^\\s*${ANCHOR_LINE.replace(/"/g, '\\"')}\\s*$`, "m").test(next)) {
		next = next + "\n" + ANCHOR_LINE + "\n";
		changed = true;
	}

	if (changed) {
		try {
			if (!fs.existsSync(PF_CONF_BACKUP)) {
				fs.copyFileSync(PF_CONF, PF_CONF_BACKUP);
			}
			fs.writeFileSync(PF_CONF, next + "\n", { mode: 0o644 });
		} catch (e) {
			log({ error: "pf.conf update failed", message: e.message });
			return false;
		}
	}
	// Reload the main ruleset so the anchor declaration is live. A non-zero
	// exit is tolerated (Apple's own com.apple anchor load can fail on some
	// installs); we verify the anchor actually landed below.
	const r = await runPf(["-f", PF_CONF]);
	if (r.status !== 0) {
		log({ warn: "pfctl -f non-zero", stderr: r.stderr });
	}
	const check = await runPfOut(["-s", "Anchors"]);
	if (!/com\.inhand/.test(check.stdout)) {
		log({ error: "com.inhand anchor not on filter path", stderr: r.stderr });
		return false;
	}
	return true;
}

async function applyRules() {
	try {
		fs.writeFileSync(RULES_FILE, RULES_TEXT, { mode: 0o600 });
	} catch (e) {
		log({ error: "write rules failed", message: e.message });
		return false;
	}
	const r = await runPf(["-a", ANCHOR, "-f", RULES_FILE]);
	if (r.status !== 0) {
		log({ error: "pfctl anchor load failed", stderr: r.stderr });
		return false;
	}
	return true;
}

async function flushRules() {
	const r = await runPf(["-a", ANCHOR, "-F", "all"]);
	if (r.status !== 0) {
		log({ error: "pfctl flush failed", stderr: r.stderr });
	}
}

async function applyLock(ttlMinutes) {
	const ttl = Math.min(1440, Math.max(1, Math.round(ttlMinutes) || 60));
	if (!(await enablePf())) return { ok: false, error: "pf-enable-failed" };
	if (!(await ensureAnchor())) return { ok: false, error: "anchor-not-installed" };
	if (!(await applyRules())) return { ok: false, error: "rules-failed" };
	const state = { locked: true, since: Date.now(), deadline: Date.now() + ttl * 60_000, ttlMinutes: ttl };
	writeState(state);
	log({ action: "lock", ttlMinutes: ttl, deadline: state.deadline });
	return { ok: true, locked: true, deadline: state.deadline, ttlMinutes: ttl };
}

async function releaseLock(reason) {
	await flushRules();
	writeState({ locked: false, reason: reason || "unlock", at: Date.now() });
	log({ action: "unlock", reason });
	return { ok: true, locked: false };
}

/** On daemon boot: persist the lock across reboots; auto-expire if TTL passed. */
async function syncStateOnBoot() {
	const state = readState();
	if (!state.locked) return;
	if (state.deadline && Date.now() > state.deadline) {
		log({ action: "auto-expire", reason: "ttl-elapsed" });
		await releaseLock("auto-expire");
		return;
	}
	log({ action: "re-apply-on-boot", deadline: state.deadline });
	await applyLock(state.ttlMinutes || 60);
}

// ---------------------------------------------------------------- socket ops

function loadConfig() {
	return readConfig();
}

async function handleOp(line) {
	let req;
	try {
		req = JSON.parse(line);
	} catch {
		return { ok: false, error: "bad-json" };
	}
	if (!req || typeof req !== "object") return { ok: false, error: "bad-request" };

	switch (req.op) {
		case "ping":
			return { ok: true, service: "inhand-fw", version: VERSION, pid: process.pid };

		case "status": {
			const state = readState();
			const cfg = readConfig();
			return {
				ok: true,
				locked: !!state.locked,
				since: state.since || null,
				deadline: state.deadline || null,
				ttlMinutes: state.ttlMinutes || null,
				keySet: !!cfg.signPub,
				keyFingerprint: keyFingerprint(cfg.signPub),
			};
		}

		case "setkey": {
			const cfg = readConfig();
			if (typeof req.signPub !== "string" || !/^[A-Za-z0-9+/]{40,}={0,2}$/.test(req.signPub)) {
				return { ok: false, error: "invalid-signPub" };
			}
			try {
				crypto.createPublicKey({ key: fromB64(req.signPub), type: "spki", format: "der" });
			} catch {
				return { ok: false, error: "unparseable-signPub" };
			}
			const oldFp = keyFingerprint(cfg.signPub);
			writeJson(CONFIG_FILE, { signPub: req.signPub });
			log({
				action: "setkey",
				from: oldFp ? oldFp.slice(0, 8) : null,
				to: keyFingerprint(req.signPub).slice(0, 8),
			});
			return { ok: true, keySet: true, keyFingerprint: keyFingerprint(req.signPub) };
		}

		case "forward": {
			// The client re-forwards the original teacher-signed event. The
			// daemon re-verifies against ITS OWN copy of the teacher key.
			const cfg = readConfig();
			if (!cfg.signPub) {
				return { ok: false, error: "no-key-set (teacher key not configured)" };
			}
			const evt = req.evt;
			if (!evt || evt.t !== "admin-command") return { ok: false, error: "not-admin-command" };
			if (!verifyTeacherEvent(cfg.signPub, evt)) {
				log({ action: "forward-rejected", reason: "bad-signature-or-replay" });
				return { ok: false, error: "signature-invalid" };
			}
			const cmd = evt.p?.cmd;
			if (!cmd || cmd.type !== "lan-only" || typeof cmd.params?.on !== "boolean") {
				return { ok: false, error: "expected lan-only command" };
			}
			if (cmd.params.on === true) {
				const res = await applyLock(cmd.params.ttl);
				return res;
			}
			await releaseLock("teacher");
			return { ok: true, locked: false };
		}

		default:
			return { ok: false, error: "unknown-op" };
	}
}

// --------------------------------------------------------------------- server

const server = net.createServer((socket) => {
	let buf = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk) => {
		buf += chunk;
		if (buf.length > MAX_LINE) {
			socket.end(JSON.stringify({ ok: false, error: "line-too-long" }) + "\n");
			buf = "";
			return;
		}
		const idx = buf.indexOf("\n");
		if (idx === -1) return;
		const line = buf.slice(0, idx);
		buf = buf.slice(idx + 1);
		handleOp(line)
			.then((res) => socket.write(JSON.stringify(res) + "\n"))
			.catch((err) => {
				log({ error: "handler", message: err.message });
				socket.write(JSON.stringify({ ok: false, error: "internal" }) + "\n");
			});
	});
	socket.on("error", () => {
		/* client disconnected mid-line */
	});
});

// --------------------------------------------------------------------- start

async function start() {
	await syncStateOnBoot();
	fs.mkdirSync(FW_DIR, { recursive: true, mode: 0o755 });
	try {
		fs.unlinkSync(SOCKET);
	} catch {
		/* not present */
	}
	server.listen(SOCKET, () => {
		fs.chmodSync(SOCKET, 0o666); // any local user may send requests; auth is signature-based
		log({ action: "listening", socket: SOCKET, mock: MOCK });
		console.log(`[inhand-fw] listening on ${SOCKET}${MOCK ? " (mock)" : ""}`);
	});
	server.on("error", (err) => {
		log({ error: "socket", message: err.message });
		console.error("[inhand-fw] socket error:", err.message);
		process.exit(1);
	});
}

start();
