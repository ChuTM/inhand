/**
 * host/lib/crypto.js — Pure cryptographic primitives (ESM).
 *
 * Key pairs:
 *   signKey : Ed25519 — teacher signs privileged events (downstream auth)
 *   encKey  : X25519  — decrypt student->teacher ECIES payloads (upstream confidentiality)
 *
 * Private keys are wrapped with a password-derived key (scrypt + AES-256-GCM).
 * No third-party dependencies.
 */
import crypto from "crypto";

// scrypt KDF cost. Production default N=2^17 (OWASP-ish baseline).
// WG_KDF_N is an escape hatch for tests / low-end hardware; never set it below
// 2^14 in production.
const KDF_N = Number(process.env.WG_KDF_N) || 2 ** 17;
const KDF_OPTS = { N: KDF_N, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 };
const HKDF_INFO = "inhand-ecies-v1";

function b64(buf) {
	return buf.toString("base64");
}

function fromB64(s) {
	return Buffer.from(s, "base64");
}

/** Generate a fresh (signKey, encKey) pair. Public halves are exported; private halves stay in the keyring. */
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

/** Wrap private keys so they can be stored at rest (0600). Returns a JSON-able blob. */
export function wrapPrivateKeys(keys, password) {
	const salt = crypto.randomBytes(16);
	const kek = crypto.scryptSync(password, salt, 32, KDF_OPTS);
	const iv = crypto.randomBytes(12);
	const payload = JSON.stringify({ signPriv: keys.signPriv, encPriv: keys.encPriv });
	const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);
	const ct = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return {
		v: 1,
		kdf: "scrypt",
		salt: b64(salt),
		iv: b64(iv),
		ct: b64(ct),
		tag: b64(tag),
		pub: { signPub: keys.signPub, encPub: keys.encPub },
	};
}

/** Unwrap private keys. Throws on wrong password / tampering. */
export function unwrapPrivateKeys(blob, password) {
	if (!blob || blob.v !== 1 || blob.kdf !== "scrypt") {
		throw new Error("Unsupported keyring format");
	}
	const kek = crypto.scryptSync(password, fromB64(blob.salt), 32, KDF_OPTS);
	const decipher = crypto.createDecipheriv("aes-256-gcm", kek, fromB64(blob.iv));
	decipher.setAuthTag(fromB64(blob.tag));
	const pt = Buffer.concat([
		decipher.update(fromB64(blob.ct)),
		decipher.final(),
	]);
	return JSON.parse(pt.toString("utf8"));
}

/** Sign a canonical string payload with the teacher's Ed25519 private key. */
export function signPayload(signPrivB64, payload) {
	const key = crypto.createPrivateKey({
		key: fromB64(signPrivB64),
		type: "pkcs8",
		format: "der",
	});
	return b64(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}

/** Verify an Ed25519 signature against a public key. Never throws. */
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

/**
 * ECIES encryption TO a public key (used by students -> teacher).
 * Student generates an ephemeral X25519 pair, ECDH with the teacher's encPub,
 * HKDF-SHA256 to an AES-256-GCM key. Only the teacher can decrypt.
 */
export function encryptTo(encPubB64, plaintext) {
	const eph = crypto.generateKeyPairSync("x25519");
	const pub = crypto.createPublicKey({
		key: fromB64(encPubB64),
		type: "spki",
		format: "der",
	});
	const secret = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
	const salt = crypto.randomBytes(16);
	const key = crypto.hkdfSync("sha256", secret, salt, HKDF_INFO, 32);
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return {
		v: 1,
		ephPub: b64(eph.publicKey.export({ type: "spki", format: "der" })),
		salt: b64(salt),
		iv: b64(iv),
		ct: b64(ct),
		tag: b64(tag),
	};
}

/** Decrypt an ECIES envelope with the teacher's X25519 private key. Throws on failure. */
export function decryptFrom(encPrivB64, env) {
	if (!env || env.v !== 1) throw new Error("Unsupported ECIES envelope");
	const priv = crypto.createPrivateKey({
		key: fromB64(encPrivB64),
		type: "pkcs8",
		format: "der",
	});
	const pub = crypto.createPublicKey({
		key: fromB64(env.ephPub),
		type: "spki",
		format: "der",
	});
	const secret = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
	const key = crypto.hkdfSync("sha256", secret, fromB64(env.salt), HKDF_INFO, 32);
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, fromB64(env.iv));
	decipher.setAuthTag(fromB64(env.tag));
	const pt = Buffer.concat([
		decipher.update(fromB64(env.ct)),
		decipher.final(),
	]);
	return pt.toString("utf8");
}

/** Canonical string for signing: stable field order, no ambiguity. */
export function canonicalize(eventType, payload, ts, nonce) {
	return JSON.stringify({ t: eventType, p: payload || null, ts, n: nonce });
}
