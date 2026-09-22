/**
 * tools/server/config.mjs — Configuration loader.
 *
 * Priority: environment variable > config file (config.json next to this
 * file, or the path from --config) > built-in default.
 *
 * Every key can also be overridden by an env var of the same name (e.g.
 * STORAGE_DRIVER=sqlite, PORT=9000, ADMIN_TOKEN=..., BASE_PATH=/api/v1).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
	HOST: "127.0.0.1",
	PORT: 8787,
	BASE_PATH: "/api/v1",
	// Storage driver: "sqlite" | "json" | "memory" | "firestore"
	// (implement a new driver by adding drivers/<name>.mjs with the storage
	//  interface described in README.md — nothing else needs to change)
	STORAGE_DRIVER: "sqlite",
	// SQLite database file (relative to this dir unless absolute)
	DB_FILE: "data/server.db",
	// JSON storage file (only used when STORAGE_DRIVER=json)
	JSON_FILE: "data/data.json",
	// Cloud Ed25519 keypair file (created on first boot, 0600).
	// Serverless: set CLOUD_KEYPAIR_JSON (base64 of the keypair JSON) instead.
	KEYS_FILE: "data/cloud-keys.json",
	CLOUD_KEYPAIR_JSON: "",
	// Firebase / Firestore (only used when STORAGE_DRIVER=firestore):
	// FIREBASE_CREDENTIALS_JSON = base64 of the service-account JSON, or set
	// the three fields individually.
	FIREBASE_CREDENTIALS_JSON: "",
	FIREBASE_PROJECT_ID: "",
	FIREBASE_CLIENT_EMAIL: "",
	FIREBASE_PRIVATE_KEY: "",
	// Admin API token (management endpoints). If left empty a random token is
	// generated at boot and printed to the console.
	ADMIN_TOKEN: "",
	// ---- Admin authentication (Firebase Auth + WebAuthn passkeys) -----------
	// HMAC secret used to sign admin session cookies. MUST be set in
	// production (generate with: openssl rand -base64 32).
	SESSION_SECRET: "",
	// Admin session lifetime (milliseconds).
	SESSION_TTL_MS: 12 * 60 * 60 * 1000, // 12h
	// When false, Firebase ID tokens whose sign-in provider is "password"
	// (email/password) are REJECTED. Flip to true to re-enable later.
	ALLOW_EMAIL_PASSWORD: false,
	// Comma-separated list of admin emails that overrides/backfills the
	// Firestore/storage allowlist (useful for bootstrapping the first admin).
	ALLOWED_ADMIN_EMAILS: "",
	// WebAuthn relying-party id (no scheme, no port). Derived per request:
	// origins on localhost use "localhost"; anything else must match RP_ID.
	RP_ID: "inhand-server.vercel.app",
	// Comma-separated list of allowed origins for WebAuthn + Firebase Auth.
	RP_ORIGINS: "https://inhand-server.vercel.app,http://localhost:3000,http://localhost:8787,http://localhost:3001",
	// How long a registration stays valid without a heartbeat. Schools are
	// offline overnight/weekends, so the default is 7 days; a teacher can
	// request longer (or infinite) per-registration via ttlMs=0.
	REGISTRATION_TTL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
	// Heartbeat interval advertised to the host (client re-registers this often)
	HEARTBEAT_MS: 60 * 1000,
	// Sweep expired registrations on this interval
	SWEEP_INTERVAL_MS: 60 * 1000,
	// After a key rotation, keep the previous public key in discover responses
	// for this long so clients that have not updated yet can still verify
	KEY_GRACE_MS: 24 * 60 * 60 * 1000, // 24h
	// Public-IP detection: "auto" (x-forwarded-for first, then socket),
	// "socket", or "header:<NAME>"
	PUBLIC_IP_MODE: "auto",
	// Light rate limit per IP for public endpoints (requests per window)
	RATE_LIMIT: 300,
	RATE_LIMIT_WINDOW_MS: 60 * 1000,
	// Request logging
	VERBOSE: true,
	LOG_FILE: "", // e.g. "data/access.log" for file logging (JSONL)
};

function envValue(key) {
	return process.env[key] !== undefined ? process.env[key] : undefined;
}

function toNumber(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function toBool(v) {
	if (typeof v === "boolean") return v;
	if (v === "true" || v === "1") return true;
	if (v === "false" || v === "0") return false;
	return undefined;
}

export function loadConfig(argv = []) {
	let fileConfig = {};
	const flagIdx = argv.indexOf("--config");
	if (flagIdx !== -1 && argv[flagIdx + 1]) {
		const p = path.resolve(argv[flagIdx + 1]);
		fileConfig = JSON.parse(fs.readFileSync(p, "utf8"));
	} else {
		const defaultPath = path.join(__dirname, "..", "config.json");
		if (fs.existsSync(defaultPath)) {
			fileConfig = JSON.parse(fs.readFileSync(defaultPath, "utf8"));
		}
	}

	const cfg = { ...DEFAULTS, ...fileConfig };

	// Env overrides (scalar coercion where the default is numeric/bool)
	for (const key of Object.keys(DEFAULTS)) {
		const raw = envValue(key);
		if (raw === undefined) continue;
		if (typeof DEFAULTS[key] === "number") {
			const n = toNumber(raw);
			if (n !== undefined) cfg[key] = n;
		} else if (typeof DEFAULTS[key] === "boolean") {
			const b = toBool(raw);
			if (b !== undefined) cfg[key] = b;
		} else {
			cfg[key] = raw;
		}
	}

	// Resolve file paths relative to this directory
	for (const key of ["DB_FILE", "JSON_FILE", "KEYS_FILE", "LOG_FILE"]) {
		if (cfg[key] && !path.isAbsolute(cfg[key])) {
			// Paths in config.json are relative to the server root (tools/server),
			// not to this file's directory (src/).
			cfg[key] = path.join(__dirname, "..", cfg[key]);
		}
	}

	return cfg;
}
