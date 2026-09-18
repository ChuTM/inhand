/**
 * tools/server/crypto.mjs — Self-contained cloud crypto for the InHand
 * discovery server.
 *
 * Same primitives as the rest of the repo (host/lib/crypto.mjs), copied here
 * so the server can be deployed as an independent unit. The server holds the
 * CLOUD Ed25519 keypair and signs discovery payloads + update manifests.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

function b64(buf) {
	return buf.toString("base64");
}

function fromB64(s) {
	return Buffer.from(s, "base64");
}

/** Generate a fresh Ed25519 (sign) + X25519 (enc) keypair. */
export function generateKeyPair() {
	const sign = crypto.generateKeyPairSync("ed25519");
	const enc = crypto.generateKeyPairSync("x25519");
	return {
		signPub: b64(sign.publicKey.export({ type: "spki", format: "der" })),
		signPriv: b64(sign.privateKey.export({ type: "pkcs8", format: "der" })),
		encPub: b64(enc.publicKey.export({ type: "spki", format: "der" })),
		encPriv: b64(enc.privateKey.export({ type: "pkcs8", format: "der" })),
	};
}

/** Sign a UTF-8 string with the Ed25519 private key. Returns base64. */
export function signPayload(signPrivB64, payload) {
	const key = crypto.createPrivateKey({
		key: fromB64(signPrivB64),
		type: "pkcs8",
		format: "der",
	});
	return b64(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}

/** Verify an Ed25519 signature. Never throws; returns boolean. */
export function verifyPayload(signPubB64, payload, sigB64) {
	try {
		if (!signPubB64 || !sigB64) return false;
		const key = crypto.createPublicKey({
			key: fromB64(signPubB64),
			type: "spki",
			format: "der",
		});
		return crypto.verify(
			null,
			Buffer.from(payload, "utf8"),
			key,
			fromB64(sigB64),
		);
	} catch {
		return false;
	}
}

/** Load or create a persisted cloud keypair (0600). */
export function loadOrCreateKeys(file) {
	if (fs.existsSync(file)) {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	}
	const keys = generateKeyPair();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
	return keys;
}

/**
 * Load the cloud keypair with serverless in mind.
 * Priority: config.CLOUD_KEYPAIR_JSON (base64 of the keypair JSON — the way
 * to pin the key in Vercel/Firebase env vars) > persisted file > generate.
 * On Vercel a generated key is useless (ephemeral FS + per-instance state),
 * so we fail loudly instead of silently breaking discover signatures.
 */
export function loadCloudKeys(config) {
	if (config.CLOUD_KEYPAIR_JSON) {
		try {
			const parsed = JSON.parse(
				Buffer.from(config.CLOUD_KEYPAIR_JSON, "base64").toString("utf8"),
			);
			if (!parsed.signPub || !parsed.signPriv || !parsed.encPub || !parsed.encPriv) {
				throw new Error("missing keypair fields");
			}
			return parsed;
		} catch (e) {
			throw new Error(`CLOUD_KEYPAIR_JSON is invalid: ${e.message}`);
		}
	}
	if (fs.existsSync(config.KEYS_FILE)) {
		return JSON.parse(fs.readFileSync(config.KEYS_FILE, "utf8"));
	}
	if (process.env.VERCEL) {
		throw new Error(
			"CLOUD_KEYPAIR_JSON is not set — set it to the base64 of the cloud keypair JSON " +
				"(generate one locally with: node -e \"import('./crypto.mjs').then(m=>console.log(Buffer.from(JSON.stringify(m.generateKeyPair())).toString('base64')))\"",
		);
	}
	fs.mkdirSync(path.dirname(config.KEYS_FILE), { recursive: true });
	return loadOrCreateKeys(config.KEYS_FILE);
}
