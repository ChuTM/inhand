/**
 * client/lib/crypto.js — Crypto helpers for the InHand client (CJS).
 *
 * The client holds only PUBLIC keys (teacher's + cloud's). It verifies the
 * teacher's Ed25519 signatures on downlink events and ECIES-encrypts all
 * uplink payloads (X25519 + HKDF-SHA256 + AES-256-GCM) so only the teacher
 * can read them.
 */
const crypto = require("crypto");

const HKDF_INFO = "inhand-ecies-v1";

/** Stable canonical string used for signature inputs. */
function canonicalize(type, payload, ts, nonce) {
	return JSON.stringify({ t: type, p: payload ?? null, ts, n: nonce });
}

/**
 * Verify an Ed25519 signature over the canonical form.
 * @param {string|Buffer} signPub Base64 (or raw) Ed25519 public key (SPKI DER)
 * @param {string} message
 * @param {string} sig Base64 signature
 */
function verifyPayload(signPub, message, sig) {
	try {
		const pub = Buffer.isBuffer(signPub)
			? signPub
			: Buffer.from(String(signPub), "base64");
		const s = Buffer.isBuffer(sig) ? sig : Buffer.from(String(sig), "base64");
		const key = crypto.createPublicKey({
			key: pub,
			type: "spki",
			format: "der",
		});
		return crypto.verify(null, Buffer.from(message, "utf8"), key, s);
	} catch {
		return false;
	}
}

/**
 * ECIES-encrypt a JSON-serializable object to the teacher's X25519 public key.
 * Returns an envelope object ready to be JSON.stringify'd.
 */
function encryptTo(encPub, obj) {
	const pub = Buffer.isBuffer(encPub)
		? encPub
		: Buffer.from(String(encPub), "base64");

	const eph = crypto.generateKeyPairSync("x25519");
	const ephPub = eph.publicKey.export({ type: "spki", format: "der" });
	const shared = crypto.diffieHellman({
		privateKey: eph.privateKey,
		publicKey: crypto.createPublicKey({ key: pub, format: "der", type: "spki" }),
	});

	const salt = crypto.randomBytes(16);
	const hkdf = crypto.hkdfSync("sha256", shared, salt, HKDF_INFO, 32);
	const iv = crypto.randomBytes(12);

	const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
	const cipher = crypto.createCipheriv("aes-256-gcm", hkdf, iv);
	const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();

	return {
		enc: true,
		v: 1,
		ephPub: ephPub.toString("base64"),
		salt: salt.toString("base64"),
		iv: iv.toString("base64"),
		ct: ct.toString("base64"),
		tag: tag.toString("base64"),
	};
}

/** Guard against replay: nonce + 120s window. */
function createNonceGuard(windowMs = 120000) {
	const seen = new Set();
	return {
		check(envelope) {
			if (!envelope || typeof envelope !== "object") return false;
			if (!envelope.n || typeof envelope.n !== "string") return false;
			const ts = Number(envelope.ts);
			if (!Number.isFinite(ts)) return false;
			if (Math.abs(Date.now() - ts) > windowMs) return false;
			if (seen.has(envelope.n)) return false;
			seen.add(envelope.n);
			if (seen.size > 20000) {
				for (const n of seen) {
					if (seen.size < 10000) break;
					seen.delete(n);
				}
			}
			return true;
		},
	};
}

module.exports = {
	canonicalize,
	verifyPayload,
	encryptTo,
	createNonceGuard,
};
